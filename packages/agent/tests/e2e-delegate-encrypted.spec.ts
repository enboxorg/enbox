/**
 * e2e: delegate + encrypted protocol
 *
 * Regression tests for https://github.com/enboxorg/enbox/issues/817
 *
 * Verifies that protocols with `encryptionRequired: true` behave correctly
 * in delegate (wallet-connect) sessions:
 *
 *   1. Protocol installation during connect injects `$encryption` keys
 *   2. Delegate writes produce encrypted records (not plaintext)
 *   3. Delegate reads decrypt ciphertext back to plaintext
 *   4. Owner/local encrypted protocol baseline still works
 *   5. Protocol definition equality ignores injected `$encryption`
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

// ─── Test protocol with encryptionRequired ──────────────────────

const encryptedNoteProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-encrypted-notes',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {} },
};

// ─── Helpers ────────────────────────────────────────────────────

/** Extract the raw RecordsWrite message without auto-decryption. */
async function queryRawEntry(
  harness: PlatformAgentTestHarness,
  authorDid: string,
  protocol: string,
): Promise<RecordsWriteMessage | undefined> {
  const { reply } = await harness.agent.processDwnRequest({
    author        : authorDid,
    target        : authorDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : { filter: { protocol } },
    // No `encryption: true` — we want the raw ciphertext
  });
  return reply.entries?.[0] as RecordsWriteMessage | undefined;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('e2e: delegate + encrypted protocol', () => {
  /** Wallet-side test harness (owns the DID). */
  let walletHarness: PlatformAgentTestHarness;
  /** Delegate-side test harness (acts on behalf of the wallet). */
  let delegateHarness: PlatformAgentTestHarness;
  let walletIdentity: BearerIdentity;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypted-wallet',
    });

    delegateHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-encrypted-delegate',
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

  // ─── 1. Protocol installation during connect ────────────────

  describe('protocol installation during connect', () => {
    it('should inject $encryption keys when prepareProtocol is called with an encrypted protocol', async () => {
      // Simulate the wallet-side connect flow: prepareProtocol installs the
      // protocol with encryption: true, injecting $encryption keys.
      // We call the internal function by invoking submitConnectResponse
      // through the connect protocol helper.

      // Install the protocol directly via the wallet's agent with
      // encryption: true (same as prepareProtocol now does).
      const { reply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      expect(reply.status.code).toBe(202);

      // Query back and verify $encryption was injected
      const { reply: queryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      expect(queryReply.entries).toHaveLength(1);

      const installedDef = (queryReply.entries![0] as any).descriptor.definition;
      expect(installedDef.structure.note.$encryption).toBeDefined();
      expect(installedDef.structure.note.$encryption.rootKeyId).toContain('#enc');
      expect(installedDef.structure.note.$encryption.publicKeyJwk).toBeDefined();
    });
  });

  // ─── 2. Delegate writes produce encrypted records ───────────

  describe('delegate encrypted writes', () => {
    it('should produce encrypted records when writing to an encrypted protocol type', async () => {
      // Step 1: Install protocol on wallet with encryption
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });

      // Step 2: Simulate what a delegate does — process a write with
      // encryption: true. Since we're on the same agent here, we
      // simulate the delegate by using the same identity but marking
      // encryption: true (as TypedEnbox now does for delegates).
      const noteData = 'This is a secret delegate note';
      const { reply: writeReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });
      expect(writeReply.status.code).toBe(202);

      // Step 3: Query without auto-decrypt to verify the record is encrypted
      const rawEntry = await queryRawEntry(
        walletHarness, walletIdentity.did.uri, encryptedNoteProtocol.protocol,
      );
      expect(rawEntry).toBeDefined();
      expect(rawEntry!.encryption).toBeDefined();
      expect(rawEntry!.encryption!.recipients).toBeDefined();
      expect(rawEntry!.encryption!.recipients.length).toBeGreaterThan(0);

      // Verify the encryption uses ProtocolPath scheme
      const recipient = rawEntry!.encryption!.recipients[0];
      expect(recipient.header.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });
  });

  // ─── 3. Delegate reads decrypt ciphertext ───────────────────

  describe('delegate encrypted reads with delivered key', () => {
    it('should decrypt records using a delivered protocol path key', async () => {
      // Step 1: Install encrypted protocol on wallet
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });

      // Step 2: Write an encrypted record
      const noteData = 'Secret note for delegate read test';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });

      // Step 3: Derive keys through the real deriveScopedDecryptionKeys path
      // — same code that submitConnectResponse calls during the connect flow.
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: encryptedNoteProtocol.protocol },
      ];
      const delegateKeys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, readScopes as any, encryptedNoteProtocol,
      );
      expect(delegateKeys).toHaveLength(1);

      // Step 4: Import the delivered keys into the delegate harness
      // (simulates what importDelegateAndSetupSync does with the connect response)
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        walletIdentity.did.uri, delegateKeys,
      );

      // Step 5: Import the wallet identity into the delegate agent so it can
      // sign messages as the wallet DID. In a real flow, the delegate would
      // use a delegated grant; here we import the identity for simplicity.
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      // Step 6: Copy the encrypted protocol + record to the delegate's DWN
      // (simulates sync bringing over the data)
      const { reply: protoQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      const protocolMessage = protoQueryReply.entries![0];

      // Install protocol on delegate's local DWN
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri,
        protocolMessage as any,
      );

      // Copy the encrypted record to delegate's local DWN
      const { reply: recordQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });

      for (const entry of recordQueryReply.entries ?? []) {
        // Read the full record with data
        const { reply: readReply } = await walletHarness.agent.processDwnRequest({
          author        : walletIdentity.did.uri,
          target        : walletIdentity.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: (entry as RecordsWriteMessage).recordId } },
        });

        if (readReply.entry?.recordsWrite && readReply.entry?.data) {
          const dataBytes = await DataStream.toBytes(readReply.entry.data);
          await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri,
            readReply.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
        }
      }

      // Step 6: Read with auto-decrypt using the delegate's agent
      // The delegate's agent should use the imported protocol path key
      const { reply: decryptedReply } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { protocol: encryptedNoteProtocol.protocol },
        },
        encryption: true,
      });

      expect(decryptedReply.status.code).toBe(200);
      expect(decryptedReply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(decryptedReply.entry!.data!);
      const decryptedText = new TextDecoder().decode(decryptedBytes);
      expect(decryptedText).toBe(noteData);
    });
  });

  // ─── 4. Owner baseline still works ──────────────────────────

  describe('owner encrypted protocol baseline', () => {
    it('should install, write, and read encrypted records as owner', async () => {
      // Install
      const { reply: configReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      expect(configReply.status.code).toBe(202);

      // Write
      const noteData = 'Owner secret note';
      const { reply: writeReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });
      expect(writeReply.status.code).toBe(202);

      // Read with decrypt
      const { reply: readReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { protocol: encryptedNoteProtocol.protocol },
        },
        encryption: true,
      });
      expect(readReply.status.code).toBe(200);

      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteData);

      // Verify raw is actually encrypted
      const rawEntry = await queryRawEntry(
        walletHarness, walletIdentity.did.uri, encryptedNoteProtocol.protocol,
      );
      expect(rawEntry!.encryption).toBeDefined();
    });
  });

  // ─── 5. prepareProtocol injects encryption in connect flow ──

  describe('prepareProtocol with encryption', () => {
    it('should detect encryptionRequired types and pass encryption: true', async () => {
      // Use the agent's processDwnRequest to simulate what prepareProtocol
      // does (check for existing, install if missing, with encryption).
      const needsEncryption = Object.values(encryptedNoteProtocol.types ?? {})
        .some((type: any) => type?.encryptionRequired === true);
      expect(needsEncryption).toBe(true);

      // Install via the same path prepareProtocol uses
      const { reply: sendReply } = await walletHarness.agent.sendDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      // 202 = accepted, 409 = already exists
      expect([202, 409]).toContain(sendReply.status.code);
    });
  });

  // ─── 6. deriveScopedDecryptionKeys direct tests ──────────────

  describe('deriveScopedDecryptionKeys', () => {
    it('should return empty array for write-only scopes', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const writeOnlyScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: encryptedNoteProtocol.protocol },
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Delete, protocol: encryptedNoteProtocol.protocol },
      ];

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, writeOnlyScopes as any, encryptedNoteProtocol,
      );
      expect(keys).toHaveLength(0);
    });

    it('should return one protocol-wide key for unrestricted read scope', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: encryptedNoteProtocol.protocol },
      ];

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, readScopes as any, encryptedNoteProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].derivedPrivateKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should throw for protocolPath-scoped read on encrypted protocol', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const pathScopes = [
        {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Query,
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
        },
      ];

      await expect(
        EnboxConnectProtocol.deriveScopedDecryptionKeys(
          walletHarness.agent, walletIdentity.did.uri,
          encryptedNoteProtocol.protocol, pathScopes as any, encryptedNoteProtocol,
        )
      ).rejects.toThrow('protocolPath is not supported');
    });

    it('should throw for contextId-scoped read on encrypted protocol', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const contextScopes = [
        {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : encryptedNoteProtocol.protocol,
          contextId : 'some-context-id',
        },
      ];

      await expect(
        EnboxConnectProtocol.deriveScopedDecryptionKeys(
          walletHarness.agent, walletIdentity.did.uri,
          encryptedNoteProtocol.protocol, contextScopes as any, encryptedNoteProtocol,
        )
      ).rejects.toThrow('contextId is not supported');
    });

    it('should throw for multi-party encrypted protocols (recipient who/of read)', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Protocol with relational recipient read access → multi-party
      const multiPartyProtocol: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/multi-party-encrypted-relational',
        types     : {
          email      : { schema: 'https://schemas.xyz/email', dataFormats: ['application/json'], encryptionRequired: true },
          attachment : { schema: 'https://schemas.xyz/attachment', dataFormats: ['application/octet-stream'] },
        },
        structure: {
          email: {
            $actions: [
              { who: 'anyone', can: ['create'] },
              { who: 'recipient', of: 'email', can: ['read'] },
            ],
            attachment: {},
          },
        },
      };

      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: multiPartyProtocol.protocol },
      ];

      await expect(
        EnboxConnectProtocol.deriveScopedDecryptionKeys(
          walletHarness.agent, walletIdentity.did.uri,
          multiPartyProtocol.protocol, readScopes as any, multiPartyProtocol,
        )
      ).rejects.toThrow('multi-party');
    });

    it('should throw for multi-party encrypted protocols ($role descendants)', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Protocol with $role record → multi-party via role-based access
      const roleProtocol: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/multi-party-encrypted-role',
        types     : {
          thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'], encryptionRequired: true },
          participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
          message     : { schema: 'https://schemas.xyz/message', dataFormats: ['text/plain'], encryptionRequired: true },
        },
        structure: {
          thread: {
            $actions    : [{ who: 'anyone', can: ['create'] }],
            participant : { $role: true },
            message     : {
              $actions: [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };

      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: roleProtocol.protocol },
      ];

      await expect(
        EnboxConnectProtocol.deriveScopedDecryptionKeys(
          walletHarness.agent, walletIdentity.did.uri,
          roleProtocol.protocol, readScopes as any, roleProtocol,
        )
      ).rejects.toThrow('multi-party');
    });
  });

  // ─── 8. Cache lifecycle: clear on disconnect, clean re-import ─

  describe('delegate decryption key cache lifecycle', () => {
    it('should clear cache and allow clean re-import (reconnect scenario)', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: encryptedNoteProtocol.protocol },
      ];
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, readScopes as any, encryptedNoteProtocol,
      );
      expect(keys).toHaveLength(1);

      // Import keys (first session)
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        walletIdentity.did.uri, keys,
      );

      // Clear (simulates disconnect)
      delegateHarness.agent.dwn.clearDelegateDecryptionKeys();

      // Re-import (simulates restore / reconnect) — should not accumulate
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        walletIdentity.did.uri, keys,
      );

      // Install the encrypted protocol on the delegate's DWN and write a record
      // to verify the re-imported keys actually work for decryption.
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });

      const noteData = 'Reconnect decryption test';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });

      // Import wallet identity for signing + copy protocol + record to delegate
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );

      const { reply: recQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      for (const entry of recQuery.entries ?? []) {
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

      // Decrypt with the re-imported keys — should succeed
      const { reply: decryptedReply } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
        encryption    : true,
      });
      expect(decryptedReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(decryptedReply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteData);
    });

    it('should replace old keys when same connectedDid re-imports (reconnect)', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const { X25519 } = await import('@enbox/crypto');

      // Derive a real key for the encrypted protocol
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: encryptedNoteProtocol.protocol },
      ];
      const realKeys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, readScopes as any, encryptedNoteProtocol,
      );
      expect(realKeys).toHaveLength(1);

      // Create a bogus key for a different protocol
      const bogusKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(bogusKeyBytes);
      const bogusJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: bogusKeyBytes });
      const bogusKeys = [{
        protocol          : 'https://stale-protocol.xyz',
        derivedPrivateKey : {
          rootKeyId         : 'did:example:old#enc',
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://stale-protocol.xyz'],
          derivedPrivateKey : bogusJwk as any,
        },
      }];

      // First import: stale session with bogus keys
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        walletIdentity.did.uri, bogusKeys,
      );

      // Second import: reconnect with real keys — must REPLACE, not accumulate
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        walletIdentity.did.uri, realKeys,
      );

      // Set up the delegate DWN with the encrypted protocol + record
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      const noteData = 'Overwrite test';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });

      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      // Copy protocol + record to delegate DWN
      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );
      const { reply: recQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      for (const entry of recQuery.entries ?? []) {
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

      // Decrypt must succeed — proves the real keys replaced the bogus ones
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
        encryption    : true,
      });
      expect(decrypted.status.code).toBe(200);
      const bytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(bytes)).toBe(noteData);
    });
  });

  // ─── 9. Protocol definition equality ignores $encryption ────

  describe('protocol definition equality', () => {
    it('should treat definitions with and without $encryption as logically equal', async () => {
      // Uses the production definitionsEqual() exported from @enbox/api.
      const { definitionsEqual } = await import('../../api/src/typed-enbox.js');

      const sourceDefinition = encryptedNoteProtocol;

      // Simulate an installed definition with $encryption injected
      const installedDefinition = JSON.parse(JSON.stringify(sourceDefinition));
      installedDefinition.structure.note.$encryption = {
        rootKeyId    : 'did:dht:alice#enc',
        publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'fake-key' },
      };

      // Production definitionsEqual strips $encryption before comparing
      expect(definitionsEqual(installedDefinition, sourceDefinition)).toBe(true);

      // Verify it still detects real differences
      const differentDefinition = JSON.parse(JSON.stringify(sourceDefinition));
      differentDefinition.types.note.schema = 'https://different-schema.xyz';
      expect(definitionsEqual(differentDefinition, sourceDefinition)).toBe(false);
    });
  });
});
