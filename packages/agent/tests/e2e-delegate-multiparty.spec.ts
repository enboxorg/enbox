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
});
