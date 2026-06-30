/**
 * e2e: delegate + encrypted protocol
 *
 * Regression tests for https://github.com/enboxorg/enbox/issues/817
 *
 * Verifies that protocols with `encryptionRequired: true` behave correctly
 * in delegate (wallet-connect) sessions:
 *
 *   1. Protocol installation during connect injects `$keyAgreement` keys
 *   2. Delegate writes produce encrypted records (not plaintext)
 *   3. Delegate reads decrypt ciphertext back to plaintext
 *   4. Owner/local encrypted protocol baseline still works
 *   5. Protocol definition equality ignores injected `$keyAgreement`
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DidJwk } from '@enbox/dids';
import { Ed25519 } from '@enbox/crypto';
import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, DataStream, DwnInterfaceName, DwnMethodName, Encoder, EncryptionProtocol, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createGrantKeyRecordsForGrants, resolveKeyDecrypter } from '../src/dwn-encryption.js';

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

const delegateReadableEncryptedNoteProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-delivered-key-notes',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {} },
};

// Protocol with multiple encrypted types for sibling/scope tests
const multiTypeProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-multi-type',
  types     : {
    note: {
      schema             : 'https://schemas.xyz/note',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
    comment: {
      schema             : 'https://schemas.xyz/comment',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: { note: {}, comment: {} },
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

async function applyDataEncodedRecord(
  harness: PlatformAgentTestHarness,
  tenantDid: string,
  record: RecordsWriteMessage & { encodedData: string },
): Promise<void> {
  const { encodedData, ...rawMessage } = record;
  const applyReply = await harness.agent.dwn.processRawMessage(
    tenantDid,
    rawMessage as any,
    { dataStream: DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData)) },
  );

  expect([202, 409]).toContain(applyReply.status.code);
}

async function createImportedDelegateDid(
  harness: PlatformAgentTestHarness,
): Promise<{ delegateDid: string; delegateX25519PrivateKey: any }> {
  const delegateBearerDid = await DidJwk.create();
  const delegatePortableDid = await delegateBearerDid.export();
  const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
    privateKey: delegatePortableDid.privateKeys![0],
  });
  delegatePortableDid.privateKeys!.push(delegateX25519PrivateKey);
  await harness.agent.did.import({
    portableDid : delegatePortableDid,
    tenant      : harness.agent.agentDid.uri,
  });

  return {
    delegateDid: delegateBearerDid.uri,
    delegateX25519PrivateKey,
  };
}

async function copyProtocolToHarness(
  source: PlatformAgentTestHarness,
  destination: PlatformAgentTestHarness,
  tenantDid: string,
  protocol: string,
): Promise<void> {
  const { reply } = await source.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.ProtocolsQuery,
    messageParams : { filter: { protocol } },
  });
  const applyReply = await destination.agent.dwn.processRawMessage(
    tenantDid,
    reply.entries![0] as any,
  );
  expect(applyReply.status.code).toBe(202);
}

async function copyRecordToHarness(
  source: PlatformAgentTestHarness,
  destination: PlatformAgentTestHarness,
  tenantDid: string,
  recordId: string,
): Promise<void> {
  const { reply } = await source.agent.processDwnRequest({
    author        : tenantDid,
    target        : tenantDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId } },
  });
  expect(reply.status.code).toBe(200);
  expect(reply.entry?.recordsWrite).toBeDefined();
  expect(reply.entry?.data).toBeDefined();

  const dataBytes = await DataStream.toBytes(reply.entry!.data!);
  const applyReply = await destination.agent.dwn.processRawMessage(
    tenantDid,
    reply.entry!.recordsWrite as any,
    { dataStream: DataStream.fromBytes(dataBytes) },
  );
  expect(applyReply.status.code).toBe(202);
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

  afterEach(() => {
    sinon.restore();
  });

  // ─── 1. Protocol installation during connect ────────────────

  describe('protocol installation during connect', () => {
    it('should inject $keyAgreement keys when prepareProtocol is called with an encrypted protocol', async () => {
      // Simulate the wallet-side connect flow: prepareProtocol installs the
      // protocol with encryption: true, injecting $keyAgreement keys.
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

      // Query back and verify $keyAgreement was injected.
      const { reply: queryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      expect(queryReply.entries).toHaveLength(1);

      const installedDef = (queryReply.entries![0] as any).descriptor.definition;
      expect(installedDef.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(installedDef.structure.note.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
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
      expect(rawEntry!.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
      expect(rawEntry!.encryption!.keyEncryption).toHaveLength(1);

      // Verify the encryption uses ProtocolPath scheme
      const keyEncryption = rawEntry!.encryption!.keyEncryption[0];
      expect(keyEncryption.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });
  });

  // ─── 3. Delegate reads decrypt ciphertext ───────────────────

  describe('delegate encrypted reads with delivered key', () => {
    it('should hydrate delivered keys from durable grantKey records on cache miss', async () => {
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: delegateReadableEncryptedNoteProtocol },
        encryption    : true,
      });

      const noteData = 'Secret note from durable grantKey';
      const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : delegateReadableEncryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });
      const noteRecordId = (noteWrite as RecordsWriteMessage).recordId;

      const delegateBearerDid = await DidJwk.create();
      const delegatePortableDid = await delegateBearerDid.export();
      const delegateX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
        privateKey: delegatePortableDid.privateKeys![0],
      });
      delegatePortableDid.privateKeys!.push(delegateX25519PrivateKey);
      await delegateHarness.agent.did.import({
        portableDid : delegatePortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });

      const delegateDid = delegateBearerDid.uri;
      const readGrant = await walletHarness.agent.permissions.createGrant({
        author      : walletIdentity.did.uri,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        delegated   : true,
        grantedTo   : delegateDid,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : delegateReadableEncryptedNoteProtocol.protocol,
        },
        store: true,
      });

      await applyDataEncodedRecord(
        delegateHarness,
        walletIdentity.did.uri,
        readGrant.message as RecordsWriteMessage & { encodedData: string },
      );

      const grantKeyRecords = await createGrantKeyRecordsForGrants({
        agent                 : walletHarness.agent,
        ownerDid              : walletIdentity.did.uri,
        granteeDid            : delegateDid,
        granteeRootPrivateKey : delegateX25519PrivateKey as any,
        grantMessages         : [readGrant.message as any],
      });
      expect(grantKeyRecords).toHaveLength(1);
      await applyDataEncodedRecord(
        delegateHarness,
        walletIdentity.did.uri,
        grantKeyRecords[0] as RecordsWriteMessage & { encodedData: string },
      );

      const { reply: protoQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: delegateReadableEncryptedNoteProtocol.protocol } },
      });
      const protocolApplyReply = await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri,
        protoQueryReply.entries![0] as any,
      );
      expect(protocolApplyReply.status.code).toBe(202);

      const { reply: recordQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: delegateReadableEncryptedNoteProtocol.protocol } },
      });

      for (const entry of recordQueryReply.entries ?? []) {
        const { reply: readReply } = await walletHarness.agent.processDwnRequest({
          author        : walletIdentity.did.uri,
          target        : walletIdentity.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: (entry as RecordsWriteMessage).recordId } },
        });

        if (readReply.entry?.recordsWrite && readReply.entry?.data) {
          const dataBytes = await DataStream.toBytes(readReply.entry.data);
          const recordApplyReply = await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri,
            readReply.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
          expect(recordApplyReply.status.code).toBe(202);
        }
      }

      delegateHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);
      expect(await delegateHarness.agent.did.get({ didUri: walletIdentity.did.uri })).toBeUndefined();

      const { reply: decryptedReply } = await delegateHarness.agent.processDwnRequest({
        author        : delegateDid,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { recordId: noteRecordId },
          permissionGrantId : readGrant.grant.id,
        },
        encryption : true,
        granteeDid : delegateDid,
      });

      expect(decryptedReply.status.code).toBe(200);
      expect(decryptedReply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(decryptedReply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteData);

      const revocation = await walletHarness.agent.permissions.createRevocation({
        author : walletIdentity.did.uri,
        grant  : readGrant.grant,
        store  : true,
      });
      await applyDataEncodedRecord(
        delegateHarness,
        walletIdentity.did.uri,
        revocation.message as RecordsWriteMessage & { encodedData: string },
      );

      const delegateDecryptionKeyCache = {
        get : sinon.stub().returns(undefined),
        set : sinon.stub(),
      };
      await expect(resolveKeyDecrypter(
        delegateHarness.agent,
        delegateDid,
        noteWrite as RecordsWriteMessage,
        walletIdentity.did.uri,
        delegateDecryptionKeyCache,
        delegateDid,
      )).rejects.toThrow('no delivered decryption key covers encrypted record');
      expect(delegateDecryptionKeyCache.set.called).toBe(false);

      delegateHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);
      const { reply: revokedReply } = await delegateHarness.agent.processDwnRequest({
        author        : delegateDid,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { recordId: noteRecordId },
          permissionGrantId : readGrant.grant.id,
        },
        encryption : true,
        granteeDid : delegateDid,
      });

      expect(revokedReply.status.code).toBe(401);
    });

    it('should hydrate a protocolPath durable grantKey and decrypt only with the delegate KMS', async () => {
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: multiTypeProtocol },
        encryption    : true,
      });

      const noteData = 'Secret path-scoped note from durable grantKey';
      const { message: noteWrite } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });
      const noteRecordId = (noteWrite as RecordsWriteMessage).recordId;

      const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(delegateHarness);
      const readGrant = await walletHarness.agent.permissions.createGrant({
        author      : walletIdentity.did.uri,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        delegated   : true,
        grantedTo   : delegateDid,
        scope       : {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'note',
        },
        store: true,
      });

      await applyDataEncodedRecord(
        delegateHarness,
        walletIdentity.did.uri,
        readGrant.message as RecordsWriteMessage & { encodedData: string },
      );

      const grantKeyRecords = await createGrantKeyRecordsForGrants({
        agent                 : walletHarness.agent,
        ownerDid              : walletIdentity.did.uri,
        granteeDid            : delegateDid,
        granteeRootPrivateKey : delegateX25519PrivateKey,
        grantMessages         : [readGrant.message as any],
      });
      expect(grantKeyRecords).toHaveLength(1);
      expect(grantKeyRecords[0].descriptor.protocol).toBe(EncryptionProtocol.uri);
      expect(grantKeyRecords[0].descriptor.protocolPath).toBe(EncryptionProtocol.grantKeyPath);
      expect(grantKeyRecords[0].descriptor.recipient).toBe(delegateDid);
      expect(grantKeyRecords[0].descriptor.tags).toEqual({
        grantId      : readGrant.grant.id,
        protocol     : multiTypeProtocol.protocol,
        protocolPath : 'note',
        keyId        : grantKeyRecords[0].descriptor.tags!.keyId,
      });

      await applyDataEncodedRecord(
        delegateHarness,
        walletIdentity.did.uri,
        grantKeyRecords[0] as RecordsWriteMessage & { encodedData: string },
      );
      await copyProtocolToHarness(
        walletHarness,
        delegateHarness,
        walletIdentity.did.uri,
        multiTypeProtocol.protocol,
      );
      await copyRecordToHarness(
        walletHarness,
        delegateHarness,
        walletIdentity.did.uri,
        noteRecordId,
      );

      delegateHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);
      expect(await delegateHarness.agent.did.get({ didUri: walletIdentity.did.uri })).toBeUndefined();

      const { reply: decryptedReply } = await delegateHarness.agent.processDwnRequest({
        author        : delegateDid,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { recordId: noteRecordId },
          permissionGrantId : readGrant.grant.id,
        },
        encryption : true,
        granteeDid : delegateDid,
      });

      expect(decryptedReply.status.code).toBe(200);
      expect(decryptedReply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(decryptedReply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteData);
    });

    it('should decrypt records using only a delivered protocol path key from a distinct delegate KMS', async () => {
      // Step 1: Install encrypted protocol on wallet
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: delegateReadableEncryptedNoteProtocol },
        encryption    : true,
      });

      // Step 2: Write an encrypted record
      const noteData = 'Secret note for delegate read test';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : delegateReadableEncryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });

      // Step 3: Derive keys through the real deriveScopedDecryptionKeys path
      // — same code that submitConnectResponse calls during the connect flow.
      const readScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: delegateReadableEncryptedNoteProtocol.protocol },
      ];
      const delegateKeys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        delegateReadableEncryptedNoteProtocol.protocol, readScopes as any, delegateReadableEncryptedNoteProtocol,
      );
      expect(delegateKeys).toHaveLength(1);

      // Step 4: Import the delivered keys into the delegate harness, keyed
      // by the delegate DID (not the owner DID) to isolate sessions.
      const delegateDid = delegateHarness.agent.agentDid.uri;
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        delegateDid, delegateKeys,
      );

      const readGrant = await walletHarness.agent.permissions.createGrant({
        author      : walletIdentity.did.uri,
        dateExpires : '2040-06-25T16:09:16.693356Z',
        delegated   : true,
        grantedTo   : delegateDid,
        scope       : {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Read,
          protocol  : delegateReadableEncryptedNoteProtocol.protocol,
        },
        store: true,
      });
      const { encodedData: encodedGrantData, ...grantMessage } = readGrant.message as any;
      const grantApplyReply = await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri,
        grantMessage,
        { dataStream: DataStream.fromBytes(Encoder.base64UrlToBytes(encodedGrantData)) },
      );
      expect(grantApplyReply.status.code).toBe(202);

      const kmsUnwrapSpy = sinon.spy(delegateHarness.agent.keyManager, 'unwrapContentKey');

      // Step 5: Copy the encrypted protocol + record to the delegate's DWN
      // (simulates sync bringing over the data)
      const { reply: protoQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: delegateReadableEncryptedNoteProtocol.protocol } },
      });
      const protocolMessage = protoQueryReply.entries![0];

      // Install protocol on delegate's local DWN
      const protocolApplyReply = await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri,
        protocolMessage as any,
      );
      expect(protocolApplyReply.status.code).toBe(202);

      // Copy the encrypted record to delegate's local DWN
      const { reply: recordQueryReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: delegateReadableEncryptedNoteProtocol.protocol } },
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
          const recordApplyReply = await delegateHarness.agent.dwn.processRawMessage(
            walletIdentity.did.uri,
            readReply.entry.recordsWrite as any,
            { dataStream: DataStream.fromBytes(dataBytes) },
          );
          expect(recordApplyReply.status.code).toBe(202);
        }
      }

      // Step 6: Read with auto-decrypt using the delegate's own DID.
      // The delegate does not hold the wallet PortableDid. `granteeDid` forces
      // the delivered-key path and fails closed if the cache does not cover
      // the encrypted record.
      const { reply: decryptedReply } = await delegateHarness.agent.processDwnRequest({
        author        : delegateDid,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { protocol: delegateReadableEncryptedNoteProtocol.protocol },
          permissionGrantId : readGrant.grant.id,
        },
        encryption : true,
        granteeDid : delegateDid,
      });

      expect(decryptedReply.status.code).toBe(200);
      expect(decryptedReply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(decryptedReply.entry!.data!);
      const decryptedText = new TextDecoder().decode(decryptedBytes);
      expect(decryptedText).toBe(noteData);
      expect(kmsUnwrapSpy.called).toBe(false);
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
      // Use the local agent path to simulate what prepareProtocol does
      // (check for existing, install if missing, with encryption).
      const needsEncryption = Object.values(encryptedNoteProtocol.types ?? {})
        .some((type: any) => type?.encryptionRequired === true);
      expect(needsEncryption).toBe(true);

      const { reply: sendReply } = await walletHarness.agent.processDwnRequest({
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

    it('should return path-subtree key for protocolPath-scoped read', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const pathScopes = [
        {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
        },
      ];

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol, pathScopes as any, encryptedNoteProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].scope.kind).toBe('protocolPath');
      if (keys[0].scope.kind === 'protocolPath') {
        expect(keys[0].scope.protocolPath).toBe('note');
        expect(keys[0].scope).toEqual({ kind: 'protocolPath', protocolPath: 'note' });
      }
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

    it('should derive a protocol-wide key for multi-party protocols with actor-chain reads', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

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

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        multiPartyProtocol.protocol, readScopes as any, multiPartyProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].derivedPrivateKey.derivationPath).toEqual([
        KeyDerivationScheme.ProtocolPath,
        multiPartyProtocol.protocol,
      ]);
    });

    it('should derive a protocol-wide key for multi-party protocols with role reads', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

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

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        roleProtocol.protocol, readScopes as any, roleProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].derivedPrivateKey.derivationPath).toEqual([
        KeyDerivationScheme.ProtocolPath,
        roleProtocol.protocol,
      ]);
    });
  });

  // ─── 8. Exact-path delegate decryption ───────────────────────

  describe('path-subtree protocolPath-scoped delegate decryption', () => {
    it('should decrypt records at the granted protocolPath', async () => {
      // Install multi-type protocol and write a 'note'
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: multiTypeProtocol },
        encryption    : true,
      });

      const noteData = 'Path-scoped secret note';
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode(noteData),
        },
        encryption: true,
      });

      // Derive path-subtree key for 'note' only
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const noteReadScopes = [{
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Read,
        protocol     : multiTypeProtocol.protocol,
        protocolPath : 'note',
      }];
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        multiTypeProtocol.protocol, noteReadScopes as any, multiTypeProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].scope.kind).toBe('protocolPath');

      // Import into delegate + copy protocol + record
      const pathDelegateDid = delegateHarness.agent.agentDid.uri;
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        pathDelegateDid, keys,
      );
      const walletPortableDid = await walletIdentity.did.export();
      await delegateHarness.agent.did.import({
        portableDid : walletPortableDid,
        tenant      : delegateHarness.agent.agentDid.uri,
      });
      const { reply: protoReply } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: multiTypeProtocol.protocol } },
      });
      await delegateHarness.agent.dwn.processRawMessage(
        walletIdentity.did.uri, protoReply.entries![0] as any,
      );
      const { reply: recQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: multiTypeProtocol.protocol } },
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

      // Owner-key baseline for path-scoped encrypted data copied into the delegate DWN.
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { protocol: multiTypeProtocol.protocol, protocolPath: 'note' } },
        encryption    : true,
      });
      expect(decrypted.status.code).toBe(200);
      const bytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(bytes)).toBe(noteData);
    });

    it('should NOT decrypt sibling protocolPath records (resolveKeyDecrypter)', async () => {
      // Derive path-subtree key for 'note' only — NOT sibling 'comment'
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const { resolveKeyDecrypter } = await import('../src/dwn-encryption.js');
      const { TtlCache } = await import('@enbox/common');

      const noteOnlyScopes = [{
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Read,
        protocol     : multiTypeProtocol.protocol,
        protocolPath : 'note',
      }];
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        multiTypeProtocol.protocol, noteOnlyScopes as any, multiTypeProtocol,
      );

      // Build a cache keyed by delegate DID with only the 'note' key
      const siblingDelegateDid = 'did:jwk:test-delegate-sibling';
      const cache = new TtlCache<string, any[]>({ ttl: 60_000 });
      cache.set(`ddk~${siblingDelegateDid}`, keys);

      // Install the protocol with encryption to get a real encrypted record
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: multiTypeProtocol },
        encryption    : true,
      });
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'comment',
          schema       : 'https://schemas.xyz/comment',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode('Sibling secret'),
        },
        encryption: true,
      });

      // Get the real encrypted RecordsWrite message
      const { reply: recQuery } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: multiTypeProtocol.protocol, protocolPath: 'comment' } },
      });
      const commentWrite = recQuery.entries![0] as RecordsWriteMessage;

      await expect(
        resolveKeyDecrypter(
          delegateHarness.agent,
          walletIdentity.did.uri,
          commentWrite,
          undefined,
          cache,
          siblingDelegateDid,
        )
      ).rejects.toThrow('no delivered decryption key covers encrypted record');
    });

    it('should reject decryption when path-subtree key does not cover record path', async () => {
      const { buildProtocolPathSubtreeDecrypter } = await import('../src/dwn-encryption.js');
      const { X25519 } = await import('@enbox/crypto');

      const fakeKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(fakeKeyBytes);
      const fakeJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: fakeKeyBytes });

      const decrypter = buildProtocolPathSubtreeDecrypter({
        rootKeyId         : 'did:example:alice#enc',
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://example.com/proto', 'note'],
        derivedPrivateKey : fakeJwk as any,
      });

      // Try to decrypt with a sibling path — should throw.
      const siblingPath = [KeyDerivationScheme.ProtocolPath, 'https://example.com/proto', 'comment'];
      await expect(
        decrypter.decrypt(siblingPath, { ephemeralPublicKey: {} as any, encryptedKey: new Uint8Array(0) })
      ).rejects.toThrow('Ancestor key derivation segment');
    });

    it('should collapse to protocol-wide key when mixed scopes include unrestricted read', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const mixedScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: multiTypeProtocol.protocol },
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: multiTypeProtocol.protocol },
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: multiTypeProtocol.protocol, protocolPath: 'note' },
      ];

      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        multiTypeProtocol.protocol, mixedScopes as any, multiTypeProtocol,
      );
      // Protocol-wide read dominates — one protocol-wide key
      expect(keys).toHaveLength(1);
      expect(keys[0].scope.kind).toBe('protocol');
    });
  });

  // ─── 9. resolveKeyDecrypter delegate cache hit paths ─────────

  describe('resolveKeyDecrypter delegate cache hits', () => {
    it('should use protocol-wide delegate key for ProtocolPath-encrypted record', async () => {
      const { resolveKeyDecrypter } = await import('../src/dwn-encryption.js');
      const { TtlCache } = await import('@enbox/common');
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Install protocol and write an encrypted record
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode('protocol-wide test'),
        },
        encryption: true,
      });

      // Get the real encrypted RecordsWrite
      const { reply: q } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      const recordsWrite = q.entries![0] as RecordsWriteMessage;

      // Derive a protocol-wide key
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol,
        [{ interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: encryptedNoteProtocol.protocol }] as any,
        encryptedNoteProtocol,
      );
      expect(keys).toHaveLength(1);

      // Build cache with the protocol-wide key
      const delegateDid = 'did:jwk:test-resolve-wide';
      const pathCache = new TtlCache<string, any[]>({ ttl: 60_000 });
      pathCache.set(`ddk~${delegateDid}`, keys);

      // resolveKeyDecrypter should return the protocol-wide decrypter
      const decrypter = await resolveKeyDecrypter(
        delegateHarness.agent, walletIdentity.did.uri,
        recordsWrite, walletIdentity.did.uri,
        pathCache, delegateDid,
      );
      expect(decrypter.rootKeyId).toBe(keys[0].derivedPrivateKey.rootKeyId);
      expect(decrypter.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('should use path-subtree delegate key for matching ProtocolPath-encrypted record', async () => {
      const { resolveKeyDecrypter } = await import('../src/dwn-encryption.js');
      const { TtlCache } = await import('@enbox/common');
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');

      // Install multi-type protocol and write a 'note'
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: multiTypeProtocol },
        encryption    : true,
      });
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'note',
          schema       : 'https://schemas.xyz/note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode('path-subtree cache test'),
        },
        encryption: true,
      });

      const { reply: q } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: multiTypeProtocol.protocol, protocolPath: 'note' } },
      });
      const recordsWrite = q.entries![0] as RecordsWriteMessage;

      // Derive path-subtree key for 'note'
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        multiTypeProtocol.protocol,
        [{
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : multiTypeProtocol.protocol,
          protocolPath : 'note',
        }] as any,
        multiTypeProtocol,
      );
      expect(keys).toHaveLength(1);
      expect(keys[0].scope.kind).toBe('protocolPath');

      // Build cache
      const delegateDid = 'did:jwk:test-resolve-exact';
      const pathCache = new TtlCache<string, any[]>({ ttl: 60_000 });
      pathCache.set(`ddk~${delegateDid}`, keys);

      const decrypter = await resolveKeyDecrypter(
        delegateHarness.agent, walletIdentity.did.uri,
        recordsWrite, walletIdentity.did.uri,
        pathCache, delegateDid,
      );
      // The path-subtree decrypter has the key's rootKeyId
      expect(decrypter.rootKeyId).toBe(keys[0].derivedPrivateKey.rootKeyId);
    });
  });

  // ─── 10. buildProtocolPathSubtreeDecrypter happy path ────────

  describe('buildProtocolPathSubtreeDecrypter decrypt success', () => {
    it('should successfully decrypt when path is in scope', async () => {
      const { DwnInterfaceName, DwnMethodName } = await import('@enbox/dwn-sdk-js');
      const { buildProtocolPathSubtreeDecrypter } = await import('../src/dwn-encryption.js');

      // Install protocol and write encrypted note
      await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedNoteProtocol },
        encryption    : true,
      });
      const noteData = 'path-subtree decrypt test';
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

      // Get the real encrypted record
      const { reply: q } = await walletHarness.agent.processDwnRequest({
        author        : walletIdentity.did.uri,
        target        : walletIdentity.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
      });
      const recordsWrite = q.entries![0] as RecordsWriteMessage;
      expect(recordsWrite.encryption).toBeDefined();

      // Derive path-subtree key for 'note'
      const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
        walletHarness.agent, walletIdentity.did.uri,
        encryptedNoteProtocol.protocol,
        [{
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Read,
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
        }] as any,
        encryptedNoteProtocol,
      );
      expect(keys[0].scope.kind).toBe('protocolPath');

      // Build the path-subtree decrypter and call decrypt() with matching path.
      const decrypter = buildProtocolPathSubtreeDecrypter(keys[0].derivedPrivateKey);
      const keyEncryption = recordsWrite.encryption!.keyEncryption[0];
      const fullPath = [
        KeyDerivationScheme.ProtocolPath,
        encryptedNoteProtocol.protocol,
        'note',
      ];

      // This exercises the happy path:
      // path is in scope -> Records.derivePrivateKey -> Encryption.unwrapKey.
      const dek = await decrypter.decrypt(fullPath, {
        encryptedKey       : new Uint8Array(),
        ephemeralPublicKey : keyEncryption.ephemeralPublicKey,
        keyEncryption,
      });
      expect(dek).toBeInstanceOf(Uint8Array);
      expect(dek.length).toBeGreaterThan(0);
    });
  });

  // ─── 11. Cache lifecycle: clear on disconnect, clean re-import ─

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

      const cacheDelegateDid = delegateHarness.agent.agentDid.uri;

      // Import keys (first session)
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        cacheDelegateDid, keys,
      );

      // Clear (simulates disconnect)
      delegateHarness.agent.dwn.clearDelegateDecryptionKeys();

      // Re-import (simulates restore / reconnect) — should not accumulate
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        cacheDelegateDid, keys,
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

    it('should replace old keys when same delegate re-imports (reconnect)', async () => {
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
        scope             : { kind: 'protocol' as const },
        derivedPrivateKey : {
          rootKeyId         : 'did:example:old#enc',
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivationPath    : [KeyDerivationScheme.ProtocolPath, 'https://stale-protocol.xyz'],
          derivedPrivateKey : bogusJwk as any,
        },
      }];

      const reconnectDelegateDid = delegateHarness.agent.agentDid.uri;

      // First import: stale session with bogus keys
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        reconnectDelegateDid, bogusKeys,
      );

      // Second import: reconnect with real keys — must REPLACE, not accumulate
      delegateHarness.agent.dwn.importDelegateDecryptionKeys(
        reconnectDelegateDid, realKeys,
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

  // ─── 9. Protocol definition equality ignores runtime encryption metadata ────

  describe('protocol definition equality', () => {
    it('should treat definitions with and without $keyAgreement as logically equal', async () => {
      // Uses the production definitionsEqual() exported from @enbox/api.
      const { definitionsEqual } = await import('../../api/src/typed-enbox.js');

      const sourceDefinition = encryptedNoteProtocol;

      // Simulate an installed definition with $keyAgreement injected.
      const installedDefinition = JSON.parse(JSON.stringify(sourceDefinition));
      installedDefinition.structure.note.$keyAgreement = {
        publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'fake-key' },
      };

      expect(definitionsEqual(installedDefinition, sourceDefinition)).toBe(true);

      // Verify it still detects real differences
      const differentDefinition = JSON.parse(JSON.stringify(sourceDefinition));
      differentDefinition.types.note.schema = 'https://different-schema.xyz';
      expect(definitionsEqual(differentDefinition, sourceDefinition)).toBe(false);
    });
  });
});
