/**
 * e2e: grant revocation stops future context-key delivery
 *
 * Tests for https://github.com/enboxorg/enbox/issues/828
 *
 * Uses real PlatformAgentTestHarness (not mocks) to prove that after
 * grants are revoked, deliverContextKeyToDelegatesViaDwn no longer
 * delivers context keys to the revoked delegate.
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

// Multi-party encrypted chat protocol
const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-revocation-chat',
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

describe('e2e: grant revocation stops future delivery', () => {
  let ownerHarness: PlatformAgentTestHarness;
  let ownerIdentity: BearerIdentity;

  beforeAll(async () => {
    ownerHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-grant-revocation',
    });
  });

  afterAll(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.closeStorage();
  });

  beforeEach(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.createAgentDid();

    ownerIdentity = await ownerHarness.createIdentity({
      name        : 'OwnerAlice',
      testDwnUrls : ['http://localhost:3000'],
    });
  });

  it('should not deliver context keys after grants are revoked', async () => {
    const ownerDid = ownerIdentity.did.uri;
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });

    // 1. Install the multi-party encrypted protocol
    await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // 2. Create a delegated grant for the delegate (simulates connect)
    const { DidJwk } = await import('@enbox/dids');
    const { Ed25519, X25519 } = await import('@enbox/crypto');
    const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');

    const delegateBearerDid = await DidJwk.create();
    const delegatePortableDid = await delegateBearerDid.export();
    const edKey = delegatePortableDid.privateKeys![0];
    const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
    const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
    const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
      KeyDerivationScheme.ProtocolPath,
      'https://identity.foundation/protocols/key-delivery',
      'contextKey',
    ]);
    const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
    const leafPub = await X25519.getPublicKey({ key: leafJwk });

    const readGrant = await permissionsApi.createGrant({
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

    // 3. Verify: before revocation, creating a new context DOES deliver a contextKey
    await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

    const { message: thread1 } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'Before revocation' })),
      },
      encryption: true,
    });
    const thread1Id = (thread1 as RecordsWriteMessage).recordId;

    const { reply: beforeQuery } = await ownerHarness.agent.processDwnRequest({
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
    const beforeKeys = (beforeQuery.entries ?? []).filter(
      (e: any) => e.descriptor?.tags?.contextId === thread1Id,
    );
    expect(beforeKeys.length).toBeGreaterThanOrEqual(1);

    // 4. Revoke the grant
    await permissionsApi.createRevocation({
      author : ownerDid,
      store  : true,
      grant  : readGrant.grant,
    });

    // 5. Create another new context AFTER revocation
    const { message: thread2 } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'After revocation' })),
      },
      encryption: true,
    });
    const thread2Id = (thread2 as RecordsWriteMessage).recordId;

    // 6. Verify: NO contextKey was delivered for the post-revocation context
    const { reply: afterQuery } = await ownerHarness.agent.processDwnRequest({
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
    const afterKeys = (afterQuery.entries ?? []).filter(
      (e: any) => e.descriptor?.tags?.contextId === thread2Id,
    );
    expect(afterKeys).toHaveLength(0);
  });

  it('should still deliver to non-revoked delegates after another is revoked', async () => {
    const ownerDid = ownerIdentity.did.uri;
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });

    await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    const { DidJwk } = await import('@enbox/dids');
    const { Ed25519, X25519 } = await import('@enbox/crypto');
    const { HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');

    // Helper: create a delegate with a read grant + key delivery tags
    const createDelegate = async (): Promise<{ did: string; grant: any }> => {
      const did = await DidJwk.create();
      const portable = await did.export();
      const edKey = portable.privateKeys![0];
      const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
      const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
      const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
        KeyDerivationScheme.ProtocolPath,
        'https://identity.foundation/protocols/key-delivery',
        'contextKey',
      ]);
      const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
      const leafPub = await X25519.getPublicKey({ key: leafJwk });

      const grant = await permissionsApi.createGrant({
        delegated           : true,
        store               : true,
        grantedTo           : did.uri,
        scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        dateExpires         : '2040-06-25T16:09:16.693356Z',
        author              : ownerDid,
        delegateKeyDelivery : {
          rootKeyId    : did.document.verificationMethod![0].id,
          publicKeyJwk : leafPub,
        },
      });
      return { did: did.uri, grant };
    };

    await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

    const delegateA = await createDelegate();
    const delegateB = await createDelegate();

    // Revoke delegate A only
    await permissionsApi.createRevocation({
      author : ownerDid,
      store  : true,
      grant  : delegateA.grant.grant,
    });

    // Create a new context
    const { message: thread } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'Selective revocation' })),
      },
      encryption: true,
    });
    const threadId = (thread as RecordsWriteMessage).recordId;

    // Delegate A (revoked) should NOT receive a contextKey
    const { reply: queryA } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : 'https://identity.foundation/protocols/key-delivery',
          protocolPath : 'contextKey',
          recipient    : delegateA.did,
        },
      },
    });
    const keysA = (queryA.entries ?? []).filter(
      (e: any) => e.descriptor?.tags?.contextId === threadId,
    );
    expect(keysA).toHaveLength(0);

    // Delegate B (not revoked) SHOULD receive a contextKey
    const { reply: queryB } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : 'https://identity.foundation/protocols/key-delivery',
          protocolPath : 'contextKey',
          recipient    : delegateB.did,
        },
      },
    });
    const keysB = (queryB.entries ?? []).filter(
      (e: any) => e.descriptor?.tags?.contextId === threadId,
    );
    expect(keysB.length).toBeGreaterThanOrEqual(1);
  });

  it('should self-heal revocation grant to remote DWN when fanout was missed', async () => {
    const ownerDid = ownerIdentity.did.uri;
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
    const testDwnUrl = 'http://localhost:3000';

    // 1. Install protocol + key-delivery
    await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });
    await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

    // Send protocols to remote DWN
    for (const proto of [chatProtocol.protocol, 'https://identity.foundation/protocols/key-delivery']) {
      const { reply: pq } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: proto } },
      });
      for (const e of pq.entries ?? []) {
        await ownerHarness.agent.rpc.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : ownerDid,
          message   : e as any,
        });
      }
    }

    // 2. Create delegate + session grant + revocation grant
    const { DidJwk } = await import('@enbox/dids');
    const { Ed25519, X25519 } = await import('@enbox/crypto');
    const { DataStream, HdKey, KeyDerivationScheme, PermissionsProtocol } = await import('@enbox/dwn-sdk-js');

    const delegateBearerDid = await DidJwk.create();
    const dp = await delegateBearerDid.export();
    const edKey = dp.privateKeys![0];
    const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
    const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
    const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
      KeyDerivationScheme.ProtocolPath,
      'https://identity.foundation/protocols/key-delivery',
      'contextKey',
    ]);
    const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
    const leafPub = await X25519.getPublicKey({ key: leafJwk });

    // Session grant — sent to remote DWN
    const sessionGrant = await permissionsApi.createGrant({
      delegated           : true,
      store               : true,
      grantedTo           : delegateBearerDid.uri,
      scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
      dateExpires         : '2040-06-25T16:09:16.693356Z',
      author              : ownerDid,
      delegateKeyDelivery : { rootKeyId: delegateBearerDid.document.verificationMethod![0].id, publicKeyJwk: leafPub },
    });

    // Send session grant to remote
    const { encodedData: sgEncoded, ...sgRaw } = sessionGrant.message;
    await ownerHarness.agent.rpc.sendDwnRequest({
      dwnUrl    : testDwnUrl,
      targetDid : ownerDid,
      message   : sgRaw as any,
      data      : new Blob([Uint8Array.from(atob(sgEncoded), (c: string): number => c.charCodeAt(0))]),
    });

    // Revocation grant — stored locally ONLY (simulate fanout failure)
    const revGrant = await permissionsApi.createGrant({
      delegated : true,
      store     : true,
      grantedTo : delegateBearerDid.uri,
      scope     : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : PermissionsProtocol.uri,
        contextId : sessionGrant.message.recordId,
      },
      dateExpires : '2040-06-25T16:09:16.693356Z',
      author      : ownerDid,
    });
    // Deliberately do NOT send revGrant to remote — simulates best-effort fanout failure

    // 3. Verify delivery works before revocation
    const { message: thread1 } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'Before self-heal' })),
      },
      encryption: true,
    });
    const thread1Id = (thread1 as RecordsWriteMessage).recordId;

    const { reply: beforeQ } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: 'https://identity.foundation/protocols/key-delivery', protocolPath: 'contextKey', recipient: delegateBearerDid.uri },
      },
    });
    expect((beforeQ.entries ?? []).filter((e: any) => e.descriptor?.tags?.contextId === thread1Id).length).toBeGreaterThanOrEqual(1);

    // 4. Self-healing step: read revocation grant locally and send to remote
    // (This is what disconnect/retry does before each revocation attempt)
    const { reply: revGrantRead } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: revGrant.message.recordId } },
    });
    expect(revGrantRead.status.code).toBe(200);

    const { encodedData: _revEncoded, ...revRaw } = revGrantRead.entry!.recordsWrite as any;
    const revData = revGrantRead.entry!.data
      ? new Blob([await DataStream.toBytes(revGrantRead.entry!.data!) as BlobPart])
      : undefined;
    await ownerHarness.agent.rpc.sendDwnRequest({
      dwnUrl    : testDwnUrl,
      targetDid : ownerDid,
      message   : revRaw as any,
      data      : revData,
    });

    // 5. Now revoke the session grant (owner-authored for simplicity)
    await permissionsApi.createRevocation({
      author : ownerDid,
      store  : true,
      grant  : sessionGrant.grant,
    });

    // 6. Create another context AFTER revocation
    const { message: thread2 } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'After self-heal revocation' })),
      },
      encryption: true,
    });
    const thread2Id = (thread2 as RecordsWriteMessage).recordId;

    // 7. Verify: NO contextKey delivered for the revoked delegate
    const { reply: afterQ } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: 'https://identity.foundation/protocols/key-delivery', protocolPath: 'contextKey', recipient: delegateBearerDid.uri },
      },
    });
    const afterKeys = (afterQ.entries ?? []).filter((e: any) => e.descriptor?.tags?.contextId === thread2Id);
    expect(afterKeys).toHaveLength(0);
  });

  it('should block delivery when revoked via delegated authorization (AuthManager disconnect path)', async () => {
    const ownerDid = ownerIdentity.did.uri;
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
    const { DidJwk } = await import('@enbox/dids');
    const { Ed25519, X25519 } = await import('@enbox/crypto');
    const { HdKey, KeyDerivationScheme, PermissionsProtocol } = await import('@enbox/dwn-sdk-js');

    // 1. Install protocol + key-delivery
    await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });
    await ownerHarness.agent.dwn.ensureKeyDeliveryProtocol(ownerDid);

    // 2. Create delegate with session grant + per-grant revocation grant
    const delegateBearerDid = await DidJwk.create();
    const dp = await delegateBearerDid.export();
    const edKey = dp.privateKeys![0];
    const x25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: edKey });
    dp.privateKeys!.push(x25519Key);

    // Import delegate keys into owner agent's KMS (needed for delegated signing)
    await ownerHarness.agent.did.import({
      portableDid : dp,
      tenant      : ownerHarness.agent.agentDid.uri,
    });

    const x25519Bytes = await X25519.privateKeyToBytes({ privateKey: x25519Key });
    const leafBytes = await HdKey.derivePrivateKeyBytes(x25519Bytes, [
      KeyDerivationScheme.ProtocolPath,
      'https://identity.foundation/protocols/key-delivery',
      'contextKey',
    ]);
    const leafJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafBytes });
    const leafPub = await X25519.getPublicKey({ key: leafJwk });

    const sessionGrant = await permissionsApi.createGrant({
      delegated           : true,
      store               : true,
      grantedTo           : delegateBearerDid.uri,
      scope               : { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
      dateExpires         : '2040-06-25T16:09:16.693356Z',
      author              : ownerDid,
      delegateKeyDelivery : { rootKeyId: delegateBearerDid.document.verificationMethod![0].id, publicKeyJwk: leafPub },
    });

    const revGrant = await permissionsApi.createGrant({
      delegated : true,
      store     : true,
      grantedTo : delegateBearerDid.uri,
      scope     : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : PermissionsProtocol.uri,
        contextId : sessionGrant.message.recordId,
      },
      dateExpires : '2040-06-25T16:09:16.693356Z',
      author      : ownerDid,
    });

    // 3. Revoke using DELEGATED authorization (same code path as AuthManager.disconnect)
    await permissionsApi.createRevocation({
      author            : ownerDid,
      store             : true,
      grant             : sessionGrant.grant,
      granteeDid        : delegateBearerDid.uri,
      permissionGrantId : revGrant.message.recordId,
    });

    // 4. Create new context after delegated revocation
    const { message: thread } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'After delegated revocation' })),
      },
      encryption: true,
    });
    const threadId = (thread as RecordsWriteMessage).recordId;

    // 5. Verify: no contextKey delivered for the revoked delegate
    const { reply: q } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: 'https://identity.foundation/protocols/key-delivery', protocolPath: 'contextKey', recipient: delegateBearerDid.uri },
      },
    });
    const keys = (q.entries ?? []).filter((e: any) => e.descriptor?.tags?.contextId === threadId);
    expect(keys).toHaveLength(0);
  });
});
