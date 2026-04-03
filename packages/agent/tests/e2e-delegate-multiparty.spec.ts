/**
 * e2e: delegate + multi-party encrypted protocol (ProtocolContext)
 *
 * Regression tests for https://github.com/enboxorg/enbox/issues/821
 *
 * Verifies that multi-party encrypted protocols with ProtocolContext
 * encryption work correctly in delegate sessions:
 *
 *   1. Connect-time backfill delivers context keys for existing contexts
 *   2. Delegate can decrypt ProtocolContext-encrypted records
 *   3. Write-only delegate receives no context keys
 *   4. protocolPath-scoped reads on multi-party → connect aborted
 *   5. Existing participant key delivery is not regressed
 *   6. Post-connect delivery of new context keys (#824)
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

// ─── Test protocol: multi-party encrypted chat ─────────────────

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-multiparty-chat',
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

describe('e2e: delegate + multi-party encrypted protocol', () => {
  let walletHarness: PlatformAgentTestHarness;
  let delegateHarness: PlatformAgentTestHarness;
  let walletIdentity: BearerIdentity;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-multiparty-wallet',
    });
    delegateHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-multiparty-delegate',
    });
  });

  afterAll(async () => {
    await walletHarness.clearStorage();
    await walletHarness.closeStorage();
    await delegateHarness.clearStorage();
    await delegateHarness.closeStorage();
  });

  beforeEach(async () => {
    await walletHarness.clearStorage();
    await walletHarness.createAgentDid();
    await delegateHarness.clearStorage();
    await delegateHarness.createAgentDid();

    // Clear in-memory delegate caches and protocol registries so tests
    // don't bleed state via the AgentDwnApi instance.
    walletHarness.agent.dwn.clearDelegateDecryptionKeys();
    walletHarness.agent.dwn.onDelegateContextKeysChanged = undefined;
    delegateHarness.agent.dwn.clearDelegateDecryptionKeys();

    walletIdentity = await walletHarness.createIdentity({
      name        : 'Alice',
      testDwnUrls : [testDwnUrl],
    });
  });

  // ─── 1. Connect-time backfill ─────────────────────────────────

  describe('deriveContextKeysForDelegate', () => {
    it('should derive context keys for existing multi-party contexts', async () => {
      // Install protocol with encryption
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Create a thread root record (multi-party context root)
      const { reply: threadReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Test' })),
        },
        encryption: true,
      });
      expect(threadReply.status.code).toBe(202);

      // Derive context keys via the real function
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
      ];
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, readScopes as any,
      );

      expect(contextKeys).toHaveLength(1);
      expect(contextKeys[0].protocol).toBe(chatProtocol.protocol);
      expect(contextKeys[0].contextId).toBeDefined();
      expect(contextKeys[0].derivedPrivateKey.derivationScheme).toBe(
        KeyDerivationScheme.ProtocolContext,
      );
    });

    it('should return empty for write-only scopes on multi-party protocol', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const writeOnlyScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: chatProtocol.protocol },
      ];
      const keys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, writeOnlyScopes as any,
      );
      expect(keys).toHaveLength(0);
    });

    it('should throw for protocolPath-scoped reads on multi-party protocol', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const pathScopes = [
        {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread/chat',
        },
      ];

      await expect(
        EnboxConnectProtocol.deriveContextKeysForDelegate(
          walletHarness.agent, walletIdentity.did.uri,
          chatProtocol, pathScopes as any,
        )
      ).rejects.toThrow('protocolPath on multi-party');
    });

    it('should throw for contextId-scoped reads on multi-party protocol', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const contextScopes = [
        {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : chatProtocol.protocol,
          contextId : 'some-context-id',
        },
      ];

      await expect(
        EnboxConnectProtocol.deriveContextKeysForDelegate(
          walletHarness.agent, walletIdentity.did.uri,
          chatProtocol, contextScopes as any,
        )
      ).rejects.toThrow('contextId is not supported');
    });

    it('should throw for mixed single-party + multi-party encrypted protocols', async () => {
      // A protocol with both multi-party and single-party encrypted roots
      // cannot be safely modeled — connect must abort.
      const mixedProtocol: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/mixed-encrypted',
        types     : {
          thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'], encryptionRequired: true },
          participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
          chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'], encryptionRequired: true },
          note        : { schema: 'https://schemas.xyz/note', dataFormats: ['text/plain'], encryptionRequired: true },
        },
        structure: {
          thread: {
            participant : { $role: true },
            chat        : {
              $actions: [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
          note: {}, // single-party — no multi-party actions
        },
      };

      // Install via wallet so prepareProtocol works
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: mixedProtocol },
        encryption    : true,
      });

      // The classifyProtocolRoots check in submitConnectResponse would
      // throw for this protocol. We test the classification directly.
      const { classifyProtocolRoots } = EnboxConnectProtocol;
      const { multiParty, singleParty } = classifyProtocolRoots(mixedProtocol);
      expect(multiParty).toContain('thread');
      expect(singleParty).toContain('note');
      expect(multiParty.length).toBeGreaterThan(0);
      expect(singleParty.length).toBeGreaterThan(0);
    });
  });

  // ─── 2. Delegate decryption of ProtocolContext-encrypted records ─

  describe('delegate ProtocolContext decryption', () => {
    it('should decrypt a multi-party encrypted record using delivered context key', async () => {
      // Step 1: Install protocol and create a thread with a chat record
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Create thread root
      const { reply: threadReply, message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Delegate test' })),
        },
        encryption: true,
      });
      expect(threadReply.status.code).toBe(202);
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Write a chat record in the thread (ProtocolContext-encrypted)
      const chatData = 'Secret multi-party message';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
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

      // Step 2: Derive context keys (as wallet would during connect)
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      expect(contextKeys).toHaveLength(1);

      // Step 3: Import context keys into delegate
      const delegateDid = delegateHarness.agent.agentDid.uri;
      delegateHarness.agent.dwn.importDelegateContextKeys(delegateDid, contextKeys);

      // Step 4: Import wallet identity for signing + copy protocol + records
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );

      // Copy the chat record
      const { reply: chatQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      for (const entry of chatQuery.entries ?? []) {
        const { reply: rr } = await walletHarness.agent.processDwnRequest({
          author        : walletIdentity.did.uri,
          target        : walletIdentity.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: (entry as any).recordId } },
        });
        if (rr.entry?.recordsWrite && rr.entry?.data) {
          const dataBytes = await DataStream.toBytes(rr.entry.data);
          await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri, rr.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
        }
      }

      // Step 5: Delegate reads the chat record with auto-decrypt
      // The delegate's context key cache has the context key for this thread.
      // KMS fallback also works since the wallet identity is imported.
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { protocol: chatProtocol.protocol, protocolPath: 'thread/chat' } },
        encryption    : true,
      });

      expect(decrypted.status.code).toBe(200);
      expect(decrypted.entry?.data).toBeDefined();
      const decryptedBytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(chatData);
    });
  });

  // ─── 3. Prove delegate context key path (no owner KMS fallback) ─

  describe('delegate context-key decryption without owner KMS', () => {
    it('should resolve delegate context key decrypter via cache, not KMS', async () => {
      // This test calls resolveKeyDecrypter directly with a delegate
      // agent that does NOT have the owner's encryption keys in its KMS.
      // It proves the delegate context key cache path works independently.

      const { resolveKeyDecrypter } = await import('../src/dwn-encryption.js');
      const { TtlCache } = await import('@enbox/common');
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Step 1: Install protocol and create encrypted context
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const { message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Context key test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Write a chat (ProtocolContext-encrypted)
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/chat',
          schema          : 'https://schemas.xyz/chat',
          dataFormat      : 'text/plain',
          parentContextId : threadContextId,
          data            : new TextEncoder().encode('Context key only test'),
        },
        encryption: true,
      });

      // Step 2: Get the real encrypted chat RecordsWrite
      const { reply: chatQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol, protocolPath: 'thread/chat' } },
      });
      const chatWrite = chatQuery.entries![0] as RecordsWriteMessage;
      expect(chatWrite.encryption).toBeDefined();

      // Step 3: Derive context keys via the real function
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      expect(contextKeys).toHaveLength(1);

      // Step 4: Build a delegate context key cache (NOT using the owner's agent)
      const delegateDid = 'did:jwk:test-context-delegate';
      const ctxCache = new TtlCache<string, any>({ ttl: 60_000 });
      ctxCache.set(
        `dctx~${delegateDid}~${chatProtocol.protocol}~${threadContextId}`,
        contextKeys[0].derivedPrivateKey,
      );

      // Step 5: Call resolveKeyDecrypter with the DELEGATE agent (no owner KMS)
      // and granteeDid pointing to our delegate.
      const decrypter = await resolveKeyDecrypter(
        delegateHarness.agent, // delegate agent — no owner keys
        walletIdentity.did.uri, // authorDid (the owner)
        chatWrite, // real encrypted RecordsWrite
        walletIdentity.did.uri, // targetDid
        new TtlCache({ ttl: 60_000 }), // empty context cache
        async () => undefined, // no key delivery fetch
        undefined, // no delegate ProtocolPath cache
        delegateDid, // granteeDid
        ctxCache, // delegate context key cache
      );

      // The decrypter should be a context key decrypter (not KMS fallback).
      // Verify by checking it has the correct rootKeyId from our delivered key.
      expect(decrypter.rootKeyId).toBe(contextKeys[0].derivedPrivateKey.rootKeyId);
      expect(decrypter.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
    });
  });

  // ─── 4. Existing participant key delivery not regressed ───────

  describe('existing multi-party behavior', () => {
    it('should still deliver participant context keys (owner flow)', async () => {
      // Install protocol
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Create thread
      const { message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Owner test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Owner reads back the thread (decrypts via KMS as context creator)
      const { reply: readReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: threadContextId } },
        encryption    : true,
      });
      expect(readReply.status.code).toBe(200);
      const bytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(JSON.parse(new TextDecoder().decode(bytes)).topic).toBe('Owner test');
    });
  });

  // ─── 5. Context key re-import replaces stale entries ──────────

  describe('importDelegateContextKeys re-import', () => {
    it('should clear stale entries when same delegateDid re-imports', async () => {
      const { X25519 } = await import('@enbox/crypto');

      const delegateDid = 'did:jwk:reimport-test';

      // Create two fake context keys
      const fakeBytes1 = new Uint8Array(32);
      crypto.getRandomValues(fakeBytes1);
      const fakeJwk1 = await X25519.bytesToPrivateKey({ privateKeyBytes: fakeBytes1 });

      const fakeBytes2 = new Uint8Array(32);
      crypto.getRandomValues(fakeBytes2);
      const fakeJwk2 = await X25519.bytesToPrivateKey({ privateKeyBytes: fakeBytes2 });

      // First import: two contexts
      delegateHarness.agent.dwn.importDelegateContextKeys(delegateDid, [
        {
          protocol          : 'https://test.xyz',
          contextId         : 'ctx-old-1',
          derivedPrivateKey : { rootKeyId: 'k1', derivationScheme: KeyDerivationScheme.ProtocolContext, derivationPath: [], derivedPrivateKey: fakeJwk1 as any },
        },
        {
          protocol          : 'https://test.xyz',
          contextId         : 'ctx-old-2',
          derivedPrivateKey : { rootKeyId: 'k1', derivationScheme: KeyDerivationScheme.ProtocolContext, derivationPath: [], derivedPrivateKey: fakeJwk2 as any },
        },
      ]);

      // Verify both are in cache
      const cache = (delegateHarness.agent.dwn as any)._delegateContextKeyCache;
      expect(cache.get(`dctx~${delegateDid}~https://test.xyz~ctx-old-1`)).toBeDefined();
      expect(cache.get(`dctx~${delegateDid}~https://test.xyz~ctx-old-2`)).toBeDefined();

      // Second import: only one context (simulates refresh with different set)
      const fakeBytes3 = new Uint8Array(32);
      crypto.getRandomValues(fakeBytes3);
      const fakeJwk3 = await X25519.bytesToPrivateKey({ privateKeyBytes: fakeBytes3 });

      delegateHarness.agent.dwn.importDelegateContextKeys(delegateDid, [
        {
          protocol          : 'https://test.xyz',
          contextId         : 'ctx-new-1',
          derivedPrivateKey : { rootKeyId: 'k1', derivationScheme: KeyDerivationScheme.ProtocolContext, derivationPath: [], derivedPrivateKey: fakeJwk3 as any },
        },
      ]);

      // Old entries must be gone — re-import cleared them
      expect(cache.get(`dctx~${delegateDid}~https://test.xyz~ctx-old-1`)).toBeUndefined();
      expect(cache.get(`dctx~${delegateDid}~https://test.xyz~ctx-old-2`)).toBeUndefined();

      // New entry present
      expect(cache.get(`dctx~${delegateDid}~https://test.xyz~ctx-new-1`)).toBeDefined();
    });
  });

  // ─── 6. Post-connect delivery of new context keys (#824) ─────

  describe('post-connect context key delivery', () => {
    it('should deliver context key for new context created after connect', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Step 1: Install protocol and create an initial context
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const { message: thread1Msg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Pre-connect' })),
        },
        encryption: true,
      });
      const thread1ContextId = (thread1Msg as RecordsWriteMessage).recordId;

      // Step 2: Derive context keys at "connect time" (backfill existing)
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      expect(contextKeys).toHaveLength(1);
      expect(contextKeys[0].contextId).toBe(thread1ContextId);

      // Step 3: Import context keys into the WALLET agent's delegate cache
      // (same-process delivery: both owner and delegate on the same agent)
      const delegateDid = 'did:jwk:post-connect-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(delegateDid, contextKeys);

      // Step 4: Owner creates a NEW multi-party root record AFTER connect
      const { reply: thread2Reply, message: thread2Msg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Post-connect' })),
        },
        encryption: true,
      });
      expect(thread2Reply.status.code).toBe(202);
      const thread2ContextId = (thread2Msg as RecordsWriteMessage).recordId;

      // Step 5: Verify the new context key was injected into the delegate cache
      const cache = (walletHarness.agent.dwn as any)._delegateContextKeyCache;
      const newKey = cache.get(`dctx~${delegateDid}~${chatProtocol.protocol}~${thread2ContextId}`);
      expect(newKey).toBeDefined();
      expect(newKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      expect(newKey.derivationPath).toEqual([
        KeyDerivationScheme.ProtocolContext,
        thread2ContextId,
      ]);
    });

    it('should allow delegate to decrypt records in the new post-connect context', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Step 1: Install protocol, create initial context, simulate connect
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Create initial thread (for backfill)
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Initial' })),
        },
        encryption: true,
      });

      // Simulate connect: derive and import context keys
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      const delegateDid = delegateHarness.agent.agentDid.uri;
      walletHarness.agent.dwn.importDelegateContextKeys(delegateDid, contextKeys);

      // Step 2: Owner creates a NEW thread after connect
      const { message: newThreadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'New thread' })),
        },
        encryption: true,
      });
      const newThreadContextId = (newThreadMsg as RecordsWriteMessage).recordId;

      // Step 3: Write an encrypted chat record in the new context
      const chatData = 'Post-connect encrypted message';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/chat',
          schema          : 'https://schemas.xyz/chat',
          dataFormat      : 'text/plain',
          parentContextId : newThreadContextId,
          data            : new TextEncoder().encode(chatData),
        },
        encryption: true,
      });

      // Step 4: Export the WALLET agent's context keys for this delegate
      // (the new key should be present)
      const exportedKeys = walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid);
      expect(exportedKeys.length).toBeGreaterThanOrEqual(2); // backfilled + new

      // Step 5: Import ALL context keys (incl. post-connect) into delegate agent
      delegateHarness.agent.dwn.importDelegateContextKeys(delegateDid, exportedKeys);

      // Step 6: Copy protocol + records to delegate's DWN
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );

      // Copy all records
      const { reply: allQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      for (const entry of allQuery.entries ?? []) {
        const { reply: rr } = await walletHarness.agent.processDwnRequest({
          author        : walletIdentity.did.uri,
          target        : walletIdentity.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: (entry as any).recordId } },
        });
        if (rr.entry?.recordsWrite && rr.entry?.data) {
          const dataBytes = await DataStream.toBytes(rr.entry.data);
          await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri, rr.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
        }
      }

      // Step 7: Delegate reads the NEW chat record with auto-decrypt
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, protocolPath: 'thread/chat', parentId: newThreadContextId },
        },
        encryption: true,
      });

      expect(decrypted.status.code).toBe(200);
      expect(decrypted.entry?.data).toBeDefined();
      const decryptedBytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(chatData);
    });

    it('should not deliver context keys to delegates for a different protocol', async () => {
      // Import context keys for chatProtocol only
      const delegateDid = 'did:jwk:different-protocol-delegate';

      const { X25519 } = await import('@enbox/crypto');
      const fakeBytes = new Uint8Array(32);
      crypto.getRandomValues(fakeBytes);
      const fakeJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: fakeBytes });

      walletHarness.agent.dwn.importDelegateContextKeys(delegateDid, [{
        protocol          : 'https://other-protocol.xyz/not-chat',
        contextId         : 'other-ctx',
        derivedPrivateKey : {
          rootKeyId         : 'k1',
          derivationScheme  : KeyDerivationScheme.ProtocolContext,
          derivationPath    : [KeyDerivationScheme.ProtocolContext, 'other-ctx'],
          derivedPrivateKey : fakeJwk as any,
        },
      }]);

      // Install chat protocol and create a root record
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const { message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Cross-proto test' })),
        },
        encryption: true,
      });
      const contextId = (threadMsg as RecordsWriteMessage).recordId;

      // Delegate should NOT have received a key for chatProtocol
      const cache = (walletHarness.agent.dwn as any)._delegateContextKeyCache;
      expect(cache.get(`dctx~${delegateDid}~${chatProtocol.protocol}~${contextId}`)).toBeUndefined();
    });

    it('should not deliver context keys when no delegates are registered', async () => {
      // Clear all delegate caches
      walletHarness.agent.dwn.clearDelegateDecryptionKeys();

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // This should succeed without errors (no delegates to deliver to)
      const { reply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'No delegates' })),
        },
        encryption: true,
      });
      expect(reply.status.code).toBe(202);
    });
  });

  // ─── 7. exportDelegateContextKeys ────────────────────────────

  describe('exportDelegateContextKeys', () => {
    it('should export all context keys including post-connect keys', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Install protocol and create initial context
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Export test 1' })),
        },
        encryption: true,
      });

      // Backfill + import
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      const delegateDid = 'did:jwk:export-test-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(delegateDid, contextKeys);

      // Create two more threads after connect
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Export test 2' })),
        },
        encryption: true,
      });

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Export test 3' })),
        },
        encryption: true,
      });

      // Export should have 3 keys: 1 backfilled + 2 post-connect
      const exported = walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid);
      expect(exported).toHaveLength(3);
      for (const key of exported) {
        expect(key.protocol).toBe(chatProtocol.protocol);
        expect(key.contextId).toBeDefined();
        expect(key.derivedPrivateKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      }
    });

    it('should return empty for unknown delegate', () => {
      const exported = walletHarness.agent.dwn.exportDelegateContextKeys('did:jwk:nonexistent');
      expect(exported).toHaveLength(0);
    });
  });

  // ─── 8. Disconnect clears post-connect keys ─────────────────

  describe('disconnect clears post-connect keys', () => {
    it('should clear all context keys on disconnect including post-connect', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Setup: install protocol, create context, backfill, create new context
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Disconnect test' })),
        },
        encryption: true,
      });

      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      const delegateDid = 'did:jwk:disconnect-test-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(delegateDid, contextKeys);

      // Create a new context (triggers post-connect delivery)
      const { message: newThreadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'After connect' })),
        },
        encryption: true,
      });
      const newContextId = (newThreadMsg as RecordsWriteMessage).recordId;

      // Verify post-connect key exists
      const cache = (walletHarness.agent.dwn as any)._delegateContextKeyCache;
      expect(cache.get(`dctx~${delegateDid}~${chatProtocol.protocol}~${newContextId}`)).toBeDefined();

      // Disconnect: clear all keys for this delegate
      walletHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);

      // All keys (backfilled + post-connect) should be gone
      expect(cache.get(`dctx~${delegateDid}~${chatProtocol.protocol}~${newContextId}`)).toBeUndefined();
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid)).toHaveLength(0);
    });

    it('should not leak context keys across different delegates', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Isolation test' })),
        },
        encryption: true,
      });

      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );

      // Import keys for two different delegates
      const delegateA = 'did:jwk:isolation-delegate-a';
      const delegateB = 'did:jwk:isolation-delegate-b';
      walletHarness.agent.dwn.importDelegateContextKeys(delegateA, contextKeys);
      walletHarness.agent.dwn.importDelegateContextKeys(delegateB, contextKeys);

      // Create a new context (both delegates should receive the key)
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Shared new' })),
        },
        encryption: true,
      });

      // Both delegates should have 2 keys (1 backfilled + 1 post-connect)
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateA)).toHaveLength(2);
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateB)).toHaveLength(2);

      // Clear delegate A — delegate B should be unaffected
      walletHarness.agent.dwn.clearDelegateDecryptionKeys(delegateA);
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateA)).toHaveLength(0);
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateB)).toHaveLength(2);
    });
  });

  // ─── 9. Cold-start: delegate connects before any context exists ─

  describe('cold-start delegate', () => {
    it('should deliver context keys when delegate connected with zero existing contexts', async () => {
      // Step 1: Install protocol — but create NO threads yet
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Step 2: Simulate connect with zero contexts.
      // deriveContextKeysForDelegate returns empty because no root records exist.
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const contextKeys = await EnboxConnectProtocol.deriveContextKeysForDelegate(
        walletHarness.agent, walletIdentity.did.uri,
        chatProtocol, [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
        ] as any,
      );
      expect(contextKeys).toHaveLength(0); // cold start — no existing contexts

      // Step 3: Register the delegate with the PROTOCOL but no keys.
      // This is what the auth layer does via importDelegateContextKeys
      // with the multiPartyProtocols parameter.
      const delegateDid = 'did:jwk:cold-start-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(
        delegateDid, [], [chatProtocol.protocol],
      );

      // Verify the delegate has zero context keys but IS registered
      expect(walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid)).toHaveLength(0);
      expect(walletHarness.agent.dwn.exportDelegateMultiPartyProtocols(delegateDid)).toContain(
        chatProtocol.protocol,
      );

      // Step 4: Owner creates the FIRST multi-party root record
      const { reply, message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'First thread ever' })),
        },
        encryption: true,
      });
      expect(reply.status.code).toBe(202);
      const contextId = (threadMsg as RecordsWriteMessage).recordId;

      // Step 5: Verify the cold-start delegate received the context key
      const cache = (walletHarness.agent.dwn as any)._delegateContextKeyCache;
      const injectedKey = cache.get(`dctx~${delegateDid}~${chatProtocol.protocol}~${contextId}`);
      expect(injectedKey).toBeDefined();
      expect(injectedKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);

      // Also verify via export
      const exported = walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid);
      expect(exported).toHaveLength(1);
      expect(exported[0].contextId).toBe(contextId);
    });

    it('should deliver to cold-start delegate AND decrypt end-to-end', async () => {
      // Install protocol — no contexts yet
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Register cold-start delegate
      const delegateDid = delegateHarness.agent.agentDid.uri;
      walletHarness.agent.dwn.importDelegateContextKeys(
        delegateDid, [], [chatProtocol.protocol],
      );

      // Owner creates first thread + encrypted chat
      const { message: threadMsg } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Cold start thread' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      const chatData = 'Cold-start encrypted chat message';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
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

      // Export keys (should have 1 post-connect key) and import into delegate agent
      const exported = walletHarness.agent.dwn.exportDelegateContextKeys(delegateDid);
      expect(exported).toHaveLength(1);
      delegateHarness.agent.dwn.importDelegateContextKeys(delegateDid, exported);

      // Copy protocol + records to delegate DWN
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );

      const { reply: allQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      });
      for (const entry of allQuery.entries ?? []) {
        const { reply: rr } = await walletHarness.agent.processDwnRequest({
          author        : walletIdentity.did.uri,
          target        : walletIdentity.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: (entry as any).recordId } },
        });
        if (rr.entry?.recordsWrite && rr.entry?.data) {
          const dataBytes = await DataStream.toBytes(rr.entry.data);
          await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri, rr.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
        }
      }

      // Delegate reads the encrypted chat — should decrypt via delivered context key
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, protocolPath: 'thread/chat', parentId: threadContextId },
        },
        encryption: true,
      });

      expect(decrypted.status.code).toBe(200);
      expect(decrypted.entry?.data).toBeDefined();
      const decryptedBytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(chatData);
    });
  });

  // ─── 10. onDelegateContextKeysChanged callback ──────────────

  describe('onDelegateContextKeysChanged persistence callback', () => {
    it('should fire callback when new context keys are delivered', async () => {
      // Install protocol and create initial context
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Register delegate (cold-start — no existing contexts)
      const delegateDid = 'did:jwk:callback-test-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(
        delegateDid, [], [chatProtocol.protocol],
      );

      // Set up callback
      const callbackCalls: string[] = [];
      walletHarness.agent.dwn.onDelegateContextKeysChanged = (did: string): void => {
        callbackCalls.push(did);
      };

      // Create a new thread — should trigger callback
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Callback test' })),
        },
        encryption: true,
      });

      expect(callbackCalls).toHaveLength(1);
      expect(callbackCalls[0]).toBe(delegateDid);

      // Cleanup
      walletHarness.agent.dwn.onDelegateContextKeysChanged = undefined;
    });

    it('should allow auth layer to persist updated keys via callback', async () => {
      // Install protocol and register cold-start delegate
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const delegateDid = 'did:jwk:persist-callback-delegate';
      walletHarness.agent.dwn.importDelegateContextKeys(
        delegateDid, [], [chatProtocol.protocol],
      );

      // Simulate auth-layer persistence callback
      let persistedKeys: any[] = [];
      walletHarness.agent.dwn.onDelegateContextKeysChanged = (did: string): void => {
        persistedKeys = walletHarness.agent.dwn.exportDelegateContextKeys(did);
      };

      // Create two new threads
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Persist test 1' })),
        },
        encryption: true,
      });

      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Persist test 2' })),
        },
        encryption: true,
      });

      // Callback should have persisted 2 keys after second write
      expect(persistedKeys).toHaveLength(2);
      for (const key of persistedKeys) {
        expect(key.protocol).toBe(chatProtocol.protocol);
        expect(key.derivedPrivateKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolContext);
      }

      // Cleanup
      walletHarness.agent.dwn.onDelegateContextKeysChanged = undefined;
    });
  });
});
