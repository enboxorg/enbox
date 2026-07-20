/**
 * Recipient-side role-audience decrypt failure taxonomy.
 *
 * Each test arranges one real failure shape against the live engine and asserts
 * that the recipient's failed read surfaces an `AudienceDecryptError` carrying
 * the exact machine-readable cause, instead of the former generic prose error
 * with the real cause swallowed by logging.
 */

import type { AudienceDecryptFailureCause } from '../src/dwn-encryption.js';
import type { BearerIdentity } from '../src/bearer-identity.js';
import type { DataEncodedRecordsWriteMessage, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { X25519 } from '@enbox/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI,
  EncryptionControlDeliveryRecipientAuthority,
  getRuleSetAtPath,
  KeyAgreementAlgorithm,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  SEAL_DERIVATION_SCHEME,
  Time,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import {
  AudienceDecryptError,
  createAudienceDeliveryRecord,
  generateAudienceKey,
  resolveAudienceDecryptionKey,
} from '../src/dwn-encryption.js';

const testDwnUrls: string[] = [testDwnUrl];

const ROLE_PATH = 'admin';

// Fresh protocol URI per test so audience/delivery records never bleed between tests.
function noteProtocolDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : `https://protocol.test/decrypt-taxonomy/${crypto.randomUUID()}`,
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true, $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
      note  : { $actions: [{ role: ROLE_PATH, can: ['read'] }] },
    },
  };
}

describe('AgentDwnApi audience decrypt error taxonomy', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  async function installProtocol(tenantDid: string, definition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    expect(reply.status.code).toBe(202);
  }

  async function writeRoleRecord(definition: ProtocolDefinition, recipientDid: string): Promise<{
    delivered: boolean;
    roleRecordId: string;
  }> {
    const response = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/json',
        protocol     : definition.protocol,
        protocolPath : ROLE_PATH,
        recipient    : recipientDid,
      },
      dataStream: new Blob(['{}']),
    });
    expect(response.reply.status.code).toBe(202);
    return {
      delivered    : response.audienceKeyDelivery?.delivered === true,
      roleRecordId : (response.message as RecordsWriteMessage).recordId,
    };
  }

  async function writeEncryptedNote(definition: ProtocolDefinition, data: string): Promise<RecordsWriteMessage> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(data),
        protocol     : definition.protocol,
        protocolPath : 'note',
        published    : true,
      },
    });
    expect(reply.status.code).toBe(202);
    return message as RecordsWriteMessage;
  }

  async function readNoteAs(recipientDid: string, recordId: string, options?: {
    delegatedGrant?: DataEncodedRecordsWriteMessage;
    granteeDid?: string;
    harness?: PlatformAgentTestHarness;
  }): Promise<ReadableStream<Uint8Array>> {
    const harness = options?.harness ?? testHarness;
    const { reply } = await harness.agent.dwn.processRequest({
      author        : recipientDid,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter: { recordId },
        ...(options?.delegatedGrant === undefined ? {} : { delegatedGrant: options.delegatedGrant }),
      },
      ...(options?.granteeDid === undefined ? {} : { granteeDid: options.granteeDid }),
    });
    expect(reply.status.code).toBe(200);
    return harness.agent.dwn.decryptRecordData({
      author         : recipientDid,
      dataStream     : reply.entry!.data!,
      delegatedGrant : options?.delegatedGrant,
      granteeDid     : options?.granteeDid,
      recordsWrite   : reply.entry!.recordsWrite,
      target         : alice.did.uri,
    });
  }

  async function queryCurrentAudienceKeyId(definition: ProtocolDefinition): Promise<string | undefined> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : definition.protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol  : definition.protocol,
            rolePath  : ROLE_PATH,
            contextId : '',
          },
        },
      },
    });
    expect(reply.status.code).toBe(200);
    const entry = reply.entries?.[0] as (RecordsWriteMessage & { encodedData?: string }) | undefined;
    if (entry?.encodedData === undefined) {
      return undefined;
    }
    return (Encoder.base64UrlToObject(entry.encodedData) as { keyId: string }).keyId;
  }

  function getRoleAudienceKeyId(noteWrite: RecordsWriteMessage): string {
    const roleAudienceEntry = noteWrite.encryption?.keyEncryption.find(
      (entry): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    );
    expect(roleAudienceEntry).toBeDefined();
    return roleAudienceEntry!.keyId;
  }

  function stubUnresolvableRecipientKey(): sinon.SinonStub {
    return sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
      .rejects(new Error('recipient role key unresolvable in test'));
  }

  async function expectAudienceDecryptError(
    promise: Promise<unknown>,
    cause: AudienceDecryptFailureCause,
  ): Promise<AudienceDecryptError> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AudienceDecryptError);
    const decryptError = caught as AudienceDecryptError;
    expect(decryptError.cause).toBe(cause);
    return decryptError;
  }

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/audience-decrypt-error-taxonomy',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('reports not-wrapped-for-role for a record written before the role read rule existed', async () => {
    const definition = noteProtocolDefinition();
    // Revision 1: same URI, note encrypted, but NO role and no role read rule.
    const revisionOne: ProtocolDefinition = {
      published : true,
      protocol  : definition.protocol,
      types     : { note: { dataFormats: ['text/plain'], encryptionRequired: true } },
      structure : { note: {} },
    };
    await installProtocol(alice.did.uri, revisionOne);
    const noteWrite = await writeEncryptedNote(revisionOne, 'note predating the role read rule');
    expect(noteWrite.encryption?.keyEncryption.some(
      (entry): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    )).toBe(false);

    // Revision 2 adds the role and its read rule; the key is delivered for NEW records.
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob PreRole', testDwnUrls });
    await installProtocol(bob.did.uri, definition);
    const { delivered } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(true);

    // The old record was never wrapped for the role, so no delivery can open it.
    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId),
      'not-wrapped-for-role',
    );
    expect(decryptError.recordId).toBe(noteWrite.recordId);
    expect(decryptError.protocol).toBe(definition.protocol);
    expect(decryptError.recipientDid).toBe(bob.did.uri);
    expect(decryptError.detail).toContain('re-written');
  }, 30000);

  it('reports delivery-missing when the audience exists but no delivery covers the recipient', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob Undelivered', testDwnUrls });

    // The role write lands but its key delivery is skipped (unresolvable recipient key),
    // so the audience exists with no delivery for Bob.
    const roleKeyStub = stubUnresolvableRecipientKey();
    const { delivered } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(false);
    roleKeyStub.restore();

    const noteWrite = await writeEncryptedNote(definition, 'undelivered note');
    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId),
      'delivery-missing',
    );
    expect(decryptError.recordId).toBe(noteWrite.recordId);
    expect(decryptError.detail).toContain(getRoleAudienceKeyId(noteWrite));
    expect(decryptError.detail).toContain(bob.did.uri);
  }, 30000);

  it('reports role-not-held when the delivery exists but the role record was deleted', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob Revoked', testDwnUrls });
    await installProtocol(bob.did.uri, definition);

    const { delivered, roleRecordId } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(true);
    const noteWrite = await writeEncryptedNote(definition, 'note for a revoked role holder');

    // A second, undecryptable delivery (wrapped to an unrelated key) is realistic residue;
    // hydration must skip it and still classify the verification rejection of the real one.
    const audienceKeyId = getRoleAudienceKeyId(noteWrite);
    const audienceKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      contextId    : '',
      keyId        : audienceKeyId,
      protocol     : definition.protocol,
      recipientDid : alice.did.uri,
      rolePath     : ROLE_PATH,
      sourceDid    : alice.did.uri,
    });
    expect(audienceKey).toBeDefined();
    await createAudienceDeliveryRecord({
      agent       : testHarness.agent,
      audienceKey : {
        contextId   : '',
        keyId       : audienceKeyId,
        keyMaterial : audienceKey!.keyMaterial,
        protocol    : definition.protocol,
        rolePath    : ROLE_PATH,
      },
      authorDid              : alice.did.uri,
      recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
      recipientDid           : bob.did.uri,
      recipientRolePublicKey : await X25519.getPublicKey({ key: await X25519.generateKey() }) as any,
      sourceDid              : alice.did.uri,
    });

    // Revoke the role by deleting Bob's $role record.
    const { reply: deleteReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: roleRecordId },
    });
    expect(deleteReply.status.code).toBe(202);

    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId),
      'role-not-held',
    );
    expect(decryptError.detail).toContain('not an active holder');
    expect(decryptError.detail).toContain('Skipped audience delivery');
  }, 30000);

  it('reports remote-unverifiable, not role-not-held, when the role lookup cannot consult the remote', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob RoleRemoteDown', testDwnUrls });
    await installProtocol(bob.did.uri, definition);

    const { delivered, roleRecordId } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(true);
    const noteWrite = await writeEncryptedNote(definition, 'note read during a role-lookup outage');

    // The role record is absent from the local projection AND the remote leg is down: the
    // delivery opens, but the role verification's empty result must not read as revocation.
    const { reply: deleteReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: roleRecordId },
    });
    expect(deleteReply.status.code).toBe(202);
    const sendStub = sinon.stub(testHarness.agent, 'sendDwnRequest')
      .rejects(new Error('remote transport down in test'));

    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId),
      'remote-unverifiable',
    );
    expect(decryptError.detail).toContain('could not be verified');
    expect(decryptError.detail).not.toContain('not an active holder');
    sendStub.restore();
  }, 30000);

  it('does not report delivery-missing for a delegated actor whose empty delivery view is inconclusive', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob DelegatedBlind', testDwnUrls });

    // No delivery exists for Bob (skipped at share time) — the exact emptiness a plain read by
    // Bob classifies as delivery-missing.
    const roleKeyStub = stubUnresolvableRecipientKey();
    const { delivered } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(false);
    roleKeyStub.restore();
    const noteWrite = await writeEncryptedNote(definition, 'note read through a delegated session');

    // A session delegate reads for Bob under a protocol-wide delegated grant: the delivery
    // query is authorized and comes back empty with the remote consulted, but a delegated
    // actor's view is visibility-filtered by design, so the emptiness must stay inconclusive
    // instead of classifying as delivery-missing.
    const delegate = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { name: 'Blind Session Delegate' },
    });
    const sessionReadGrant = await testHarness.agent.permissions.createGrant({
      author      : bob.did.uri,
      dateExpires : '2099-01-01T00:00:00.000000Z',
      delegated   : true,
      grantedTo   : delegate.did.uri,
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol  : definition.protocol,
      },
      store: true,
    });

    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId, {
        delegatedGrant : sessionReadGrant.message,
        granteeDid     : delegate.did.uri,
      }),
      'unknown',
    );
    expect(decryptError.cause).not.toBe('delivery-missing');
    expect(decryptError.detail).toContain('visibility-filtered');
    expect(decryptError.detail).toContain('no delivered decryption key covers');
  }, 30000);

  it('never reads an existing delivery hidden from a delegated query as delivery-missing', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    const bob = await testHarness.createIdentity({ name: 'Bob DelegatedHidden', testDwnUrls });
    await installProtocol(bob.did.uri, definition);

    // Bob's delivery EXISTS on Alice's tenant.
    const { delivered } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(true);
    const noteWrite = await writeEncryptedNote(definition, 'note whose delivery is hidden from the session');

    // The session's delegated grant is contextId-scoped — grantKey-INELIGIBLE for delivery
    // visibility — so the delivery query is authorized but the DWN filters the existing delivery
    // out of its results: a visibility-filtered empty with the remote consulted must never
    // classify as a missing delivery.
    const delegate = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { name: 'Context-Scoped Session Delegate' },
    });
    const contextScopedGrant = await testHarness.agent.permissions.createGrant({
      author      : bob.did.uri,
      dateExpires : '2099-01-01T00:00:00.000000Z',
      delegated   : true,
      grantedTo   : delegate.did.uri,
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol  : definition.protocol,
        contextId : noteWrite.contextId!,
      },
      store: true,
    });

    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId, {
        delegatedGrant : contextScopedGrant.message,
        granteeDid     : delegate.did.uri,
      }),
      'unknown',
    );
    expect(decryptError.cause).not.toBe('delivery-missing');
    expect(decryptError.detail).toContain('visibility-filtered');
    expect(decryptError.detail).toContain('no delivered decryption key covers');
  }, 30000);

  it('reports audience-superseded when the record wraps a non-current audience key', async () => {
    const definition = noteProtocolDefinition();
    await installProtocol(alice.did.uri, definition);
    // Current-key projection prefers the earliest tenant-signed `dateCreated`, so a timestamp
    // captured here lets a later insertion supersede everything minted after it — the same state a
    // sync race between two writers produces.
    const backdatedTimestamp = Time.getCurrentTimestamp();
    await Time.minimalSleep();

    const bob = await testHarness.createIdentity({ name: 'Bob Superseded', testDwnUrls });
    const roleKeyStub = stubUnresolvableRecipientKey();
    const { delivered } = await writeRoleRecord(definition, bob.did.uri);
    expect(delivered).toBe(false);
    roleKeyStub.restore();

    // The note wraps the audience key that is current at write time.
    const noteWrite = await writeEncryptedNote(definition, 'note wrapped to a soon-superseded key');
    const wrappedKeyId = getRoleAudienceKeyId(noteWrite);
    expect(await queryCurrentAudienceKeyId(definition)).toBe(wrappedKeyId);

    // Insert a backdated audience record for the same tuple. Its earlier `dateCreated` makes it
    // the tuple's current audience, superseding the key the note is wrapped to.
    const aliceProtocolReply = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: definition.protocol } },
    });
    const storedDefinition = aliceProtocolReply.reply.entries![0].descriptor.definition;
    const sealingPublicKey = getRuleSetAtPath(ROLE_PATH, storedDefinition.structure)!.$keyAgreement!.publicKeyJwk;
    const backdatedAudience = await generateAudienceKey({
      contextId : '',
      protocol  : definition.protocol,
      rolePath  : ROLE_PATH,
    });
    const sealedPrivateKey = await Encryption.wrapSeal({
      privateKeyBytes : await X25519.privateKeyToBytes({ privateKey: backdatedAudience.keyMaterial.privateKeyJwk }),
      keyInput        : {
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        audienceKeyId    : backdatedAudience.keyId,
        contextId        : '',
        derivationScheme : SEAL_DERIVATION_SCHEME,
        keyId            : await Encryption.getKeyId(sealingPublicKey as any),
        protocol         : definition.protocol,
        publicKey        : sealingPublicKey as any,
        rolePath         : ROLE_PATH,
      },
    });
    const audiencePayloadBytes = Encoder.objectToBytes({
      protocol     : definition.protocol,
      rolePath     : ROLE_PATH,
      contextId    : '',
      keyId        : backdatedAudience.keyId,
      publicKeyJwk : backdatedAudience.keyMaterial.publicKeyJwk,
      sealedPrivateKey,
    });
    const { reply: backdatedReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat       : 'application/json',
        dateCreated      : backdatedTimestamp,
        messageTimestamp : backdatedTimestamp,
        protocol         : definition.protocol,
        protocolPath     : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        schema           : ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI,
        tags             : {
          protocol  : definition.protocol,
          rolePath  : ROLE_PATH,
          contextId : '',
          keyId     : backdatedAudience.keyId,
        },
      },
      dataStream: new Blob([audiencePayloadBytes]),
    });
    expect(backdatedReply.status.code).toBe(202);
    expect(await queryCurrentAudienceKeyId(definition)).toBe(backdatedAudience.keyId);

    const decryptError = await expectAudienceDecryptError(
      readNoteAs(bob.did.uri, noteWrite.recordId),
      'audience-superseded',
    );
    expect(decryptError.detail).toContain(wrappedKeyId);
    expect(decryptError.detail).toContain(backdatedAudience.keyId);
  }, 30000);

  describe('remote-unverifiable (recipient node with a partial local projection)', () => {
    let recipientHarness: PlatformAgentTestHarness;

    beforeAll(async () => {
      recipientHarness = await PlatformAgentTestHarness.setup({
        agentClass       : TestAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/audience-decrypt-error-taxonomy-recipient',
      });
      await recipientHarness.clearStorage();
      await recipientHarness.createAgentDid();
    });

    afterAll(async () => {
      await recipientHarness.clearStorage();
      await recipientHarness.closeStorage();
    });

    it('reports remote-unverifiable when the delivery lookup is empty locally and the remote is unreachable', async () => {
      const definition = noteProtocolDefinition();
      await installProtocol(alice.did.uri, definition);
      // Minted on Alice's node during the note write; the recipient node gets the record
      // and its audience replicated, but never a delivery.
      const noteWrite = await writeEncryptedNote(definition, 'note on an unreachable tenant');
      const bob = await recipientHarness.createIdentity({ name: 'Bob RemoteDown', testDwnUrls });

      // Replicate Alice's protocol, the audience record (write admission requires it
      // before any record wrapped to it), and the note record onto the recipient node.
      const { reply: protocolReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: definition.protocol } },
      });
      const protocolApplyReply = await recipientHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        protocolReply.entries![0] as any,
      );
      expect(protocolApplyReply.status.code).toBe(202);

      const { reply: audienceReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : definition.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : definition.protocol,
              rolePath  : ROLE_PATH,
              contextId : '',
            },
          },
        },
      });
      const audienceMessage = audienceReply.entries![0] as RecordsWriteMessage & { encodedData: string };
      const { encodedData, ...rawAudienceMessage } = audienceMessage;
      const audienceApplyReply = await recipientHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        rawAudienceMessage as any,
        { dataStream: DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData)) },
      );
      expect(audienceApplyReply.status.code).toBe(202);

      const { reply: rawNoteReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: noteWrite.recordId } },
      });
      expect(rawNoteReply.status.code).toBe(200);
      const noteApplyReply = await recipientHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        rawNoteReply.entry!.recordsWrite as any,
        { dataStream: DataStream.fromBytes(await DataStream.toBytes(rawNoteReply.entry!.data!)) },
      );
      expect(noteApplyReply.status.code).toBe(202);

      // The delivery lookup finds nothing locally and the remote leg is down, so the
      // absence of a delivery cannot be asserted.
      const sendStub = sinon.stub(recipientHarness.agent, 'sendDwnRequest')
        .rejects(new Error('remote transport down in test'));
      const decryptError = await expectAudienceDecryptError(
        readNoteAs(bob.did.uri, noteWrite.recordId, { harness: recipientHarness }),
        'remote-unverifiable',
      );
      expect(decryptError.detail).toContain('$encryption/delivery');
      expect(decryptError.detail).toContain('remote DWN could not be consulted');
      sendStub.restore();
    }, 30000);
  });
});
