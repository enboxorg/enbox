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
import type { DwnRpcRequest, DwnRpcResponse } from '@enbox/dwn-clients';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { X25519 } from '@enbox/crypto';

import { DataStream, DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { retryFreshDidResolution } from './utils/remote-dwn-retry.js';
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

  async function sendRemoteSetupRequest(
    request: DwnRpcRequest
  ): Promise<DwnRpcResponse> {
    const reply = await retryFreshDidResolution(
      () => ownerHarness.agent.rpc.sendDwnRequest(request)
    );

    if (![202, 409].includes(reply.status.code)) {
      throw new Error(
        `Remote setup request failed: ${reply.status.code} ${reply.status.detail ?? ''}`
      );
    }

    return reply;
  }

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

    // 2b. Derive the delegate's key-delivery leaf public key (matches submitConnectResponse)
    const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');
    const x25519PrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: x25519PrivateKey });
    const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(
      x25519PrivateKeyBytes,
      [KeyDerivationScheme.ProtocolPath, 'https://identity.foundation/protocols/key-delivery', 'contextKey'],
    );
    const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
    const leafPublicKeyJwk = await X25519.getPublicKey({ key: leafPrivateKeyJwk });

    const delegateKeyDeliveryData = {
      rootKeyId    : delegateBearerDid.document.verificationMethod![0].id,
      publicKeyJwk : leafPublicKeyJwk,
    };

    // 3. Create permission grants on the owner's DWN
    const readMethods = new Set(['Read', 'Query', 'Subscribe']);
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
    const grants = await Promise.all(
      options.scopes.map((scope) => {
        const isReadLike = (scope as any).interface === 'Records'
          && readMethods.has((scope as any).method);
        return permissionsApi.createGrant({
          delegated           : true,
          store               : true,
          grantedTo           : delegateBearerDid.uri,
          scope,
          dateExpires         : '2040-06-25T16:09:16.693356Z',
          author              : ownerDid,
          delegateKeyDelivery : isReadLike ? delegateKeyDeliveryData : undefined,
        });
      }),
    );

    // 4. Import delegate DID as an identity with connectedDid metadata.
    // This mirrors what importDelegateAndSetupSync does in the real
    // wallet-connect flow. The connectedDid metadata is critical: it
    // registers ownerDid as a locally-managed DID on the delegate agent,
    // so processRequest routes locally instead of to the remote DWN.
    await delegateHarness.agent.identity.import({
      portableIdentity: {
        portableDid : delegatePortableDid,
        metadata    : {
          name         : 'Delegate',
          uri          : delegateBearerDid.uri,
          tenant       : delegateHarness.agent.agentDid.uri,
          connectedDid : ownerDid,
        },
      },
    });

    // Verify the delegate's X25519 key is in the KMS
    const x25519Key = delegatePortableDid.privateKeys!.find(
      (k: any): boolean => k.crv === 'X25519',
    );
    if (x25519Key) {
      const x25519Uri = await delegateHarness.agent.keyManager.getKeyUri({ key: x25519Key });
      await delegateHarness.agent.keyManager.getPublicKey({ keyUri: x25519Uri });
    }

    // 5. Import the owner's DID into the delegate agent's KMS. The
    // owner's private keys are needed because the DwnKeyStore encrypts
    // records with the tenant's X25519 key. The fail-closed guard in
    // resolveKeyDecrypter prevents using these keys for ProtocolContext
    // decryption (delegate path throws before reaching the owner KMS).
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
        ? Convert.base64Url(encodedData).toUint8Array()
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

    // 7. Ensure key-delivery protocol is installed locally (triggers
    // $encryption key derivation) and send it to the DWN server so that
    // contextKey records written later can be accepted by the remote DWN.
    await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);
    const { reply: kdProto } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: 'https://identity.foundation/protocols/key-delivery' } },
    });
    if (kdProto.entries?.[0]) {
      await sendRemoteSetupRequest({
        dwnUrl    : testDwnUrl,
        targetDid : ownerDid,
        message   : kdProto.entries[0] as any,
      });
    }

    // 8. Send chat protocol definition to DWN server
    const { reply: protoReply } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: chatProtocol.protocol } },
    });
    if (protoReply.entries?.[0]) {
      await sendRemoteSetupRequest({
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
      // At least one key delivery record must exist for the Records.Read grant.
      expect(matchingKeys.length).toBeGreaterThanOrEqual(1);
    });

    it('should allow delegate to decrypt via cross-device fetch without owner KMS', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Connect with read scope
      const { delegateDid } = await simulateCrossDeviceConnect({
        scopes: [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
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

      // Send contextKey records + chat records + grants to the DWN server
      // so the delegate can fetch them via RPC.
      const sendAllToServer = async (): Promise<void> => {
        // Send all records for all relevant protocols to the remote DWN
        for (const proto of [
          chatProtocol.protocol,
          'https://identity.foundation/protocols/key-delivery',
          'https://identity.foundation/dwn/permissions',
        ]) {
          const { reply: rq } = await ownerHarness.agent.processDwnRequest({
            author        : ownerDid,
            target        : ownerDid,
            messageType   : DwnInterface.RecordsQuery,
            messageParams : { filter: { protocol: proto } },
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
              await sendRemoteSetupRequest({
                dwnUrl    : testDwnUrl,
                targetDid : ownerDid,
                message   : rr.entry.recordsWrite as any,
                data      : new Blob([bytes]),
              });
            }
          }
        }
      };
      await sendAllToServer();

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

  // ─── 2. Remote-only context key fetch ──────────────────────────
  // Note: The remote-only RPC fetch path is covered by the unit test in
  // dwn-key-delivery.spec.ts. An e2e remote-only test is not included here
  // because the DWN server may reject contextKey records encrypted to a
  // delegate's leaf key (the server's protocol $encryption block expects
  // records encrypted to the owner's root key). In production, sync always
  // brings contextKey records to the delegate's local DWN first.

  // ─── 3. Write-only delegate exclusion ─────────────────────────

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

  // ─── 6. Fail-closed: no owner KMS fallback for delegates ─────

  describe('fail-closed: no owner KMS fallback for delegates', () => {
    it('should throw when delegate context-key fetch is unavailable even with owner keys present', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Install protocol and create an encrypted thread
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Fail-closed test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      const chatData = 'This should not be decryptable via owner KMS';
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

      // Import owner DID WITH private keys into delegate agent
      // (this is the contamination scenario — owner keys are locally present)
      const ownerPortableDid = await ownerIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : ownerPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      // Copy protocol + records to delegate's local DWN
      const { reply: protoReply } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      if (protoReply.entries?.[0]) {
        await delegateHarness.agent.dwn.processRawMessage(ownerDid, protoReply.entries[0] as any);
      }
      const { reply: rr } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: chatRecordId } },
      });
      if (rr.entry?.recordsWrite && rr.entry?.data) {
        const bytes = await DataStream.toBytes(rr.entry.data);
        await delegateHarness.agent.dwn.processRawMessage(
          ownerDid, rr.entry.recordsWrite as any,
          { dataStream: DataStream.fromBytes(bytes) },
        );
      }

      // Create a fake delegate DID (no delivered context keys, no grants with leaf keys)
      const { DidJwk } = await import('@enbox/dids');
      const fakeDelegateBearerDid = await DidJwk.create();
      // Import as identity with connectedDid so ownerDid routes locally
      const fakePortableDid = await fakeDelegateBearerDid.export();
      await delegateHarness.agent.identity.import({
        portableIdentity: {
          portableDid : fakePortableDid,
          metadata    : {
            name         : 'FakeDelegate',
            uri          : fakeDelegateBearerDid.uri,
            tenant       : delegateHarness.agent.agentDid.uri,
            connectedDid : ownerDid,
          },
        },
      });

      // Store a grant locally so the delegate request is authorized
      const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
      const grant = await permissionsApi.createGrant({
        delegated   : true,
        store       : true,
        grantedTo   : fakeDelegateBearerDid.uri,
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires : '2040-06-25T16:09:16.693356Z',
        author      : ownerDid,
      });
      const grantMsg = grant.message;
      const grantData = grantMsg.encodedData;
      const grantBytes = grantData
        ? Convert.base64Url(grantData).toUint8Array()
        : new Uint8Array(0);
      await delegateHarness.agent.dwn.processRawMessage(
        ownerDid, grantMsg as any,
        { dataStream: DataStream.fromBytes(grantBytes) },
      );

      // Delegate reads the encrypted chat with granteeDid set.
      // The fail-closed guard in resolveKeyDecrypter must either:
      // 1. Throw "does not have a context key" (DWN authorized the read, but
      //    delegate decrypt fails closed), or
      // 2. Return a non-200 response (DWN rejected the delegated read).
      // Either way, the delegate must NOT be able to read the plaintext.
      let failClosedResult: any;
      try {
        failClosedResult = await delegateHarness.agent.processDwnRequest({
          author        : ownerDid,
          target        : ownerDid,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: chatRecordId }, permissionGrantId: grantMsg.recordId },
          granteeDid    : fakeDelegateBearerDid.uri,
          encryption    : true,
        });
      } catch (e: any) {
        // Path 1: fail-closed guard threw — the right outcome.
        expect(e.message).toContain('does not have a context key');
        return;
      }
      // Path 2: DWN returned a response. If 200, the data must NOT be
      // the original plaintext (encrypted data is unreadable as text).
      if (failClosedResult.reply.status.code === 200 && failClosedResult.reply.entry?.data) {
        const bytes = await DataStream.toBytes(failClosedResult.reply.entry.data);
        expect(new TextDecoder().decode(bytes)).not.toBe(chatData);
      }
    });
  });

  // ─── 7. Deduplication ────────────────────────────────────────

  describe('deduplication', () => {
    it('should write one contextKey per delegate even with duplicate read grants', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Connect with duplicate Records.Read scopes.
      const { delegateDid } = await simulateCrossDeviceConnect({
        scopes: [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ],
      });

      // Create a new context
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Dedup test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Query contextKey records for this delegate
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

      // Despite duplicate read grants, only 1 contextKey should be written
      const matchingKeys = (ctxKeyQuery.entries ?? []).filter((entry: any) =>
        entry.descriptor?.tags?.contextId === threadContextId
      );
      expect(matchingKeys).toHaveLength(1);
    });
  });

  // ─── 8. Expired grants must not receive context keys ─────────

  describe('expired grants', () => {
    it('should not deliver context keys to delegates with expired grants', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Install protocol
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Ensure key-delivery protocol is on the DWN server
      await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);
      const { reply: kdProto } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: 'https://identity.foundation/protocols/key-delivery' } },
      });
      if (kdProto.entries?.[0]) {
        await sendRemoteSetupRequest({
          dwnUrl    : testDwnUrl,
          targetDid : ownerDid,
          message   : kdProto.entries[0] as any,
        });
      }

      // Create delegate DID with leaf key tags (same as simulateCrossDeviceConnect)
      const { DidJwk } = await import('@enbox/dids');
      const { Ed25519 } = await import('@enbox/crypto');
      const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');
      const delegateBearerDid = await DidJwk.create();
      const delegatePortableDid = await delegateBearerDid.export();
      const edPrivateKey = delegatePortableDid.privateKeys![0];
      const x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({ privateKey: edPrivateKey });
      const x25519PrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: x25519PrivateKey });
      const leafBytes = await HdKey.derivePrivateKeyBytes(x25519PrivateKeyBytes, [
        KeyDerivationScheme.ProtocolPath, 'https://identity.foundation/protocols/key-delivery', 'contextKey',
      ]);
      const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
      const leafPub = await X25519.getPublicKey({ key: leafJwk });

      // Create an EXPIRED delegated grant
      const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
      await permissionsApi.createGrant({
        delegated           : true,
        store               : true,
        grantedTo           : delegateBearerDid.uri,
        scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires         : '2020-01-01T00:00:00.000000Z', // already expired
        author              : ownerDid,
        delegateKeyDelivery : {
          rootKeyId    : delegateBearerDid.document.verificationMethod![0].id,
          publicKeyJwk : leafPub,
        },
      });

      // Owner creates a new context
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Expired test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // No contextKey should be written for the expired delegate
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : delegateBearerDid.uri,
          },
        },
      });
      const matchingKeys = (ctxKeyQuery.entries ?? []).filter((entry: any) =>
        entry.descriptor?.tags?.contextId === threadContextId
      );
      expect(matchingKeys).toHaveLength(0);
    });
  });

  // ─── 9. Non-delegated grants must not receive context keys ───

  describe('non-delegated grants', () => {
    it('should not deliver context keys to non-delegated grants', async () => {
      const ownerDid = ownerIdentity.did.uri;

      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

      const { DidJwk } = await import('@enbox/dids');
      const { Ed25519 } = await import('@enbox/crypto');
      const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');
      const directGrantee = await DidJwk.create();
      const granteePortable = await directGrantee.export();
      const edKey = granteePortable.privateKeys![0];
      const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
      const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
      const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
        KeyDerivationScheme.ProtocolPath, 'https://identity.foundation/protocols/key-delivery', 'contextKey',
      ]);
      const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
      const leafPub = await X25519.getPublicKey({ key: leafJwk });

      // Non-delegated grant (delegated: false / undefined)
      const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
      await permissionsApi.createGrant({
        delegated           : false,
        store               : true,
        grantedTo           : directGrantee.uri,
        scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires         : '2040-06-25T16:09:16.693356Z',
        author              : ownerDid,
        delegateKeyDelivery : {
          rootKeyId    : directGrantee.document.verificationMethod![0].id,
          publicKeyJwk : leafPub,
        },
      });

      // Owner creates a new context
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Non-delegated test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // No contextKey for the non-delegated grantee
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : directGrantee.uri,
          },
        },
      });
      const matchingKeys = (ctxKeyQuery.entries ?? []).filter((entry: any) =>
        entry.descriptor?.tags?.contextId === threadContextId
      );
      expect(matchingKeys).toHaveLength(0);
    });
  });

  // ─── 10. Mixed tagged/untagged grants ────────────────────────

  describe('mixed tagged/untagged grants', () => {
    it('should deliver when a valid tagged grant exists alongside an older untagged one', async () => {
      const ownerDid = ownerIdentity.did.uri;

      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

      const { DidJwk } = await import('@enbox/dids');
      const { Ed25519 } = await import('@enbox/crypto');
      const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');
      const delegateBearerDid = await DidJwk.create();
      const dp = await delegateBearerDid.export();
      const edKey = dp.privateKeys![0];
      const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
      const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
      const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
        KeyDerivationScheme.ProtocolPath, 'https://identity.foundation/protocols/key-delivery', 'contextKey',
      ]);
      const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
      const leafPub = await X25519.getPublicKey({ key: leafJwk });

      const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });

      // Grant 1: no delegateKeyDelivery (legacy / pre-feature), delegated, read-like
      await permissionsApi.createGrant({
        delegated   : true,
        store       : true,
        grantedTo   : delegateBearerDid.uri,
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires : '2040-06-25T16:09:16.693356Z',
        author      : ownerDid,
        // no delegateKeyDelivery — legacy grant
      });

      // Grant 2: with delegateKeyDelivery, delegated, read-like
      await permissionsApi.createGrant({
        delegated           : true,
        store               : true,
        grantedTo           : delegateBearerDid.uri,
        scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires         : '2040-06-25T16:09:16.693356Z',
        author              : ownerDid,
        delegateKeyDelivery : {
          rootKeyId    : delegateBearerDid.document.verificationMethod![0].id,
          publicKeyJwk : leafPub,
        },
      });

      // Owner creates a new context
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Mixed grants test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // The valid tagged grant should produce delivery despite the untagged one
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : delegateBearerDid.uri,
          },
        },
      });
      const matchingKeys = (ctxKeyQuery.entries ?? []).filter((entry: any) =>
        entry.descriptor?.tags?.contextId === threadContextId
      );
      expect(matchingKeys).toHaveLength(1);
    });
  });
});
