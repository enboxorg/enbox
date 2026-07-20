import type { PublicKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import type { AudienceKeyDeliveryOutcome } from '../src/types/dwn.js';
import type { BearerIdentity } from '../src/bearer-identity.js';

import sinon from 'sinon';
import { X25519 } from '@enbox/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionControlDeliveryRecipientAuthority,
  getRuleSetAtPath,
  Time,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createAudienceDeliveryRecord, createAudienceRecord, resolveAudienceDecryptionKey } from '../src/dwn-encryption.js';

const testDwnUrls: string[] = [testDwnUrl];

const ROLE_PATH = 'thread/participant';

// Fresh protocol URI per test so audience/delivery records never bleed between tests.
function chatProtocolDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : `https://protocol.test/delivery-primitives/${crypto.randomUUID()}`,
    types     : {
      thread      : { schema: 'https://schemas.test/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.test/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.test/chat', dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : { $actions: [{ role: ROLE_PATH, can: ['read'] }] },
      },
    },
  };
}

describe('AgentDwnApi audience key delivery primitives', () => {
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

  async function writeThread(definition: ProtocolDefinition): Promise<string> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/json',
        protocol     : definition.protocol,
        protocolPath : 'thread',
        schema       : definition.types.thread.schema,
      },
      dataStream: new Blob([JSON.stringify({ title: 'thread' })]),
    });
    expect(reply.status.code).toBe(202);
    return (message as RecordsWriteMessage).contextId!;
  }

  async function writeRoleRecord(
    definition: ProtocolDefinition,
    threadContextId: string,
    recipientDid: string,
  ): Promise<{ roleContextId: string; delivery?: AudienceKeyDeliveryOutcome }> {
    const response = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat      : 'application/json',
        parentContextId : threadContextId,
        protocol        : definition.protocol,
        protocolPath    : ROLE_PATH,
        recipient       : recipientDid,
        schema          : definition.types.participant.schema,
      },
      dataStream: new Blob([JSON.stringify({ role: 'participant' })]),
    });
    expect(response.reply.status.code).toBe(202);
    return {
      delivery      : response.audienceKeyDelivery,
      roleContextId : (response.message as RecordsWriteMessage).contextId!,
    };
  }

  async function countDeliveries(definition: ProtocolDefinition, recipientDid: string): Promise<number> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : definition.protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          recipient    : recipientDid,
        },
      },
    });
    expect(reply.status.code).toBe(200);
    return reply.entries?.length ?? 0;
  }

  async function queryAudienceKeyIds(definition: ProtocolDefinition, contextId: string): Promise<string[]> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : definition.protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol : definition.protocol,
            rolePath : ROLE_PATH,
            contextId,
          },
        },
      },
    });
    expect(reply.status.code).toBe(200);
    return (reply.entries ?? []).map((entry): string => {
      const payload = Encoder.base64UrlToObject((entry as RecordsWriteMessage & { encodedData: string }).encodedData) as { keyId: string };
      return payload.keyId;
    });
  }

  async function readRolePublicKey(tenantDid: string, protocolUri: string): Promise<PublicKeyJwk> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: protocolUri } },
    });
    const definition = reply.entries![0].descriptor.definition;
    return getRuleSetAtPath(ROLE_PATH, definition.structure)!.$keyAgreement!.publicKeyJwk as PublicKeyJwk;
  }

  async function randomX25519PublicKey(): Promise<PublicKeyJwk> {
    return await X25519.getPublicKey({ key: await X25519.generateKey() }) as PublicKeyJwk;
  }

  function stubUnresolvableRecipientKey(): sinon.SinonStub {
    return sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
      .rejects(new Error('recipient role key unresolvable in test'));
  }

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/audience-key-delivery-primitives',
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

  describe('getAudienceKeyDeliveryStatus()', () => {
    it('reports delivered after a role write provisions a delivery for the current audience key', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Delivered', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      // Bob installs the protocol on his own tenant so Alice can resolve his role-path key.
      await installProtocol(bob.did.uri, chat);

      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(true);

      // The role RECORD's contextId is accepted directly — normalization to the
      // role-audience context id happens inside the primitive.
      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : roleContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(status.status).toBe('delivered');
      expect(status.status === 'delivered' && status.keyId.length > 0).toBe(true);
      expect(status.recipientDid).toBe(bob.did.uri);
    }, 30000);

    it('reports not-delivered when no delivery record exists for the recipient', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Undelivered', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      // The recipient key cannot be resolved at share time, so the accepted $role
      // write reports a best-effort skip — the audience exists but no delivery does.
      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      expect(roleKeyStub.calledOnce).toBe(true);
      roleKeyStub.restore();

      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(status.status).toBe('not-delivered');
      expect(status.status === 'not-delivered' && status.keyId !== undefined).toBe(true);
      expect(status.status === 'not-delivered' && status.reason.includes('no $encryption/delivery record')).toBe(true);
    }, 30000);

    it('reports not-delivered when the audience tuple was never provisioned', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob NoAudience', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);

      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(status.status).toBe('not-delivered');
      expect(status.status === 'not-delivered' && status.keyId).toBeUndefined();
      expect(status.status === 'not-delivered' && status.reason.includes('no audience record')).toBe(true);
    }, 30000);

    it('does not count a delivery of a non-current audience key as delivered', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Stale', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      // Audience A is minted during the $role write, but its delivery is skipped.
      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();

      const [currentKeyId] = await queryAudienceKeyIds(chat, threadContextId);
      expect(currentKeyId).toBeDefined();

      // Mint a SECOND audience record (B) for the same tuple, strictly later than A
      // so the tenant-signed earliest-dateCreated projection keeps A current, then
      // deliver ONLY B's key to Bob. Delivery writes are validated against an
      // existing audience record, so this is how a stale-key delivery state is
      // constructed with real records.
      await Time.minimalSleep();
      const sealingPublicKey = await readRolePublicKey(alice.did.uri, chat.protocol);
      const { audienceKey: staleAudienceKey } = await createAudienceRecord({
        agent     : testHarness.agent,
        authorDid : alice.did.uri,
        contextId : threadContextId,
        protocol  : chat.protocol,
        rolePath  : ROLE_PATH,
        sealingPublicKey,
        sourceDid : alice.did.uri,
      });
      expect(staleAudienceKey.keyId).not.toBe(currentKeyId);
      await createAudienceDeliveryRecord({
        agent                  : testHarness.agent,
        audienceKey            : staleAudienceKey,
        authorDid              : alice.did.uri,
        recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : await randomX25519PublicKey(),
        sourceDid              : alice.did.uri,
      });

      // The folklore existence query (no keyId match) finds the stale delivery and
      // would falsely conclude delivered.
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);

      // The primitive matches deliveries against the CURRENT audience key only.
      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(status.status).toBe('not-delivered');
      expect(status.status === 'not-delivered' && status.keyId).toBe(currentKeyId);
    }, 30000);

    it('short-circuits to unverifiable for a delegate context without issuing any query', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Unverifiable', testDwnUrls });
      const delegate = await testHarness.agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Wallet Session Delegate' },
      });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');
      const sendSpy = sinon.spy(testHarness.agent, 'sendDwnRequest');
      const audienceResolveSpy = sinon.spy(testHarness.agent.dwn as any, 'resolveCurrentAudienceRecord');

      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        granteeDid   : delegate.did.uri,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(status.status).toBe('unverifiable');
      expect(status.status === 'unverifiable' && status.reason.includes('delegate')).toBe(true);
      // Structurally blind — the primitive must not have issued any DWN round trip.
      expect(processSpy.called).toBe(false);
      expect(sendSpy.called).toBe(false);
      expect(audienceResolveSpy.called).toBe(false);
    }, 30000);

    it('reports unverifiable when the remote cannot confirm a missing audience record', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob AudienceRemoteDown', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);

      // No audience exists locally and the remote leg is down, so an empty local
      // projection cannot be asserted as authoritative absence.
      const sendStub = sinon.stub(testHarness.agent.dwn as any, 'sendRequest')
        .rejects(new Error('remote transport down in test'));
      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });
      sendStub.restore();

      expect(status.status).toBe('unverifiable');
      expect(status.status === 'unverifiable' && status.reason.includes('remote DWN')).toBe(true);
    }, 30000);

    it('reports unverifiable when the remote cannot confirm a missing delivery record', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob DeliveryRemoteDown', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      // The audience resolves locally (minted during the role write); only the
      // delivery query's remote leg is down.
      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();

      const sendStub = sinon.stub(testHarness.agent as any, 'sendDwnRequest')
        .rejects(new Error('remote transport down in test'));
      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });
      sendStub.restore();

      expect(status.status).toBe('unverifiable');
      expect(status.status === 'unverifiable' && status.reason.includes('remote DWN')).toBe(true);
    }, 30000);

    it('throws on a nested role path without a contextId instead of guessing a tuple', async () => {
      const chat = chatProtocolDefinition();
      await expect(testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        protocol     : chat.protocol,
        recipientDid : alice.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      })).rejects.toThrow(/contextId that reaches the parent context/i);
    });
  });

  describe('reprovisionAudienceKeyDelivery()', () => {
    it('returns alreadyDelivered without writing a duplicate when the current key is already delivered', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob AlreadyDelivered', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      await installProtocol(bob.did.uri, chat);

      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(true);
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);

      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId    : roleContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(outcome).toEqual({ alreadyDelivered: true, delivered: true, recipientDid: bob.did.uri });
      // No duplicate delivery record was written.
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);
    }, 30000);

    it('repairs a delivery wrapped to the wrong recipient key instead of reporting alreadyDelivered', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Poisoned', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();

      // Poison the tuple: deliver the CURRENT audience key wrapped to an unrelated
      // key — the exact state a mistaken caller-supplied key leaves behind.
      const [audienceKeyId] = await queryAudienceKeyIds(chat, threadContextId);
      const audienceKey = await resolveAudienceDecryptionKey({
        agent        : testHarness.agent,
        contextId    : threadContextId,
        keyId        : audienceKeyId,
        protocol     : chat.protocol,
        recipientDid : alice.did.uri,
        rolePath     : ROLE_PATH,
        sourceDid    : alice.did.uri,
      });
      expect(audienceKey).toBeDefined();
      await createAudienceDeliveryRecord({
        agent       : testHarness.agent,
        audienceKey : {
          contextId   : threadContextId,
          keyId       : audienceKeyId,
          keyMaterial : audienceKey!.keyMaterial,
          protocol    : chat.protocol,
          rolePath    : ROLE_PATH,
        },
        authorDid              : alice.did.uri,
        recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : await randomX25519PublicKey(),
        sourceDid              : alice.did.uri,
      });
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);

      // Re-provision with Bob's REAL role-path key: the poisoned delivery must not
      // read as alreadyDelivered — a fresh, correctly-wrapped delivery is written.
      await installProtocol(bob.did.uri, chat);
      const bobRoleKey = await readRolePublicKey(bob.did.uri, chat.protocol);
      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : roleContextId,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : bobRoleKey,
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      });
      expect(outcome).toEqual({ delivered: true, recipientDid: bob.did.uri });
      expect(await countDeliveries(chat, bob.did.uri)).toBe(2);

      // End-to-end: recipient hydration skips the undecryptable poisoned candidate
      // and opens the repaired delivery.
      const chatText = `repaired secret ${crypto.randomUUID()}`;
      const chatWrite = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat      : 'text/plain',
          parentContextId : threadContextId,
          protocol        : chat.protocol,
          protocolPath    : 'thread/chat',
          schema          : chat.types.chat.schema,
        },
        dataStream: new Blob([chatText]),
      });
      expect(chatWrite.reply.status.code).toBe(202);
      const read = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter       : { recordId: (chatWrite.message as RecordsWriteMessage).recordId },
          protocolRole : ROLE_PATH,
        },
      });
      expect(read.reply.status.code).toBe(200);
      const decryptedStream = await testHarness.agent.dwn.decryptRecordData({
        author       : bob.did.uri,
        dataStream   : read.reply.entry!.data!,
        recordsWrite : read.reply.entry!.recordsWrite,
        target       : alice.did.uri,
      });
      const decrypted = new TextDecoder().decode(await DataStream.toBytes(decryptedStream));
      expect(decrypted).toBe(chatText);
    }, 30000);

    it('reports a best-effort failure when the recipient key cannot be resolved and none is supplied', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Unresolvable', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);
      await writeRoleRecord(chat, threadContextId, bob.did.uri);

      // No supplied key, and the recipient's role key cannot be resolved: the
      // wrap target is unknowable, so re-provisioning reports the failure.
      const roleKeyStub = stubUnresolvableRecipientKey();
      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });
      roleKeyStub.restore();

      expect(outcome.delivered).toBe(false);
      expect(!outcome.delivered && outcome.reason).toMatch(/unresolvable in test/i);
    }, 30000);

    it('coalesces concurrent re-provision calls into a single delivery write', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Concurrent', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();

      const request = {
        contextId              : roleContextId,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : await randomX25519PublicKey(),
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      };
      const [first, second] = await Promise.all([
        testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request),
        testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request),
      ]);

      expect(first.delivered).toBe(true);
      expect(second.delivered).toBe(true);
      // The non-atomic check-then-write coalesced onto one execution: one record.
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);
    }, 30000);

    it('does not coalesce delegated calls so each authorization attempt is evaluated', async () => {
      const recipientRolePublicKey = await randomX25519PublicKey();
      const recipientDid = 'did:jwk:delegated-flight-recipient';
      const delegateDid = 'did:jwk:delegated-flight-actor';
      const dwnApi = testHarness.agent.dwn as any;
      let releaseFirstExecution: (outcome: AudienceKeyDeliveryOutcome) => void = () => {};
      let signalFirstExecution: () => void = () => {};
      const firstExecution = new Promise<AudienceKeyDeliveryOutcome>((resolve): void => {
        releaseFirstExecution = resolve;
      });
      const firstExecutionStarted = new Promise<void>((resolve): void => {
        signalFirstExecution = resolve;
      });
      let executionCount = 0;
      const executeStub = sinon.stub(dwnApi, 'executeAudienceKeyDeliveryReprovision')
        .callsFake((input: { recipientDid: string }): Promise<AudienceKeyDeliveryOutcome> => {
          executionCount++;
          if (executionCount === 1) {
            signalFirstExecution();
            return firstExecution;
          }
          return Promise.resolve({
            delivered    : false,
            reason       : 'the second authorization context was evaluated independently',
            recipientDid : input.recipientDid,
          });
        });
      const request = {
        contextId  : 'delegated-flight-context',
        granteeDid : delegateDid,
        protocol   : `https://protocol.test/delegated-flight/${crypto.randomUUID()}`,
        recipientDid,
        recipientRolePublicKey,
        rolePath   : ROLE_PATH,
        target     : alice.did.uri,
      };

      const first = testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request);
      await firstExecutionStarted;
      const second = testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request);
      for (let attempt = 0; attempt < 50 && executeStub.callCount < 2; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      const executionCountBeforeRelease = executeStub.callCount;
      releaseFirstExecution({ delivered: true, recipientDid });
      const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

      expect(executionCountBeforeRelease).toBe(2);
      expect(firstOutcome).toEqual({ delivered: true, recipientDid });
      expect(secondOutcome.delivered).toBe(false);
    }, 30000);

    it('delivers after a failed initial provisioning and the recipient decrypts end-to-end', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Reprovisioned', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      // Initial share: the recipient key is unresolvable, so the $role write lands
      // but its delivery is reported as skipped.
      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();
      expect(await countDeliveries(chat, bob.did.uri)).toBe(0);

      // Bob's REAL role-path public key, derived from his own encryption root by
      // installing the protocol on his tenant — the value a recipient would carry
      // out of band for the owner to supply.
      await installProtocol(bob.did.uri, chat);
      const bobRoleKey = await readRolePublicKey(bob.did.uri, chat.protocol);

      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : roleContextId,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : bobRoleKey,
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      });
      expect(outcome).toEqual({ delivered: true, recipientDid: bob.did.uri });
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);

      // The status primitive agrees the current key is now delivered.
      const status = await testHarness.agent.dwn.getAudienceKeyDeliveryStatus({
        contextId    : roleContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });
      expect(status.status).toBe('delivered');

      // End-to-end: Alice writes an encrypted role-readable record and Bob
      // decrypts it through the re-provisioned delivery.
      const chatText = `reprovisioned secret ${crypto.randomUUID()}`;
      const chatWrite = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat      : 'text/plain',
          parentContextId : threadContextId,
          protocol        : chat.protocol,
          protocolPath    : 'thread/chat',
          schema          : chat.types.chat.schema,
        },
        dataStream: new Blob([chatText]),
      });
      expect(chatWrite.reply.status.code).toBe(202);

      const read = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter       : { recordId: (chatWrite.message as RecordsWriteMessage).recordId },
          protocolRole : ROLE_PATH,
        },
      });
      expect(read.reply.status.code).toBe(200);
      const decryptedStream = await testHarness.agent.dwn.decryptRecordData({
        author       : bob.did.uri,
        dataStream   : read.reply.entry!.data!,
        recordsWrite : read.reply.entry!.recordsWrite,
        target       : alice.did.uri,
      });
      const decrypted = new TextDecoder().decode(await DataStream.toBytes(decryptedStream));
      expect(decrypted).toBe(chatText);
    }, 30000);

    it('reports the DWN rejection when the recipient holds no active role record', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Roleless', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);

      // No $role record exists for Bob. The DWN rejects the delivery write itself;
      // the primitive surfaces that rejection instead of pre-empting it with a
      // live role query.
      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : threadContextId,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : await randomX25519PublicKey(),
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      });

      expect(outcome.delivered).toBe(false);
      expect(!outcome.delivered && outcome.reason).toMatch(/role record is missing/i);
      expect(await countDeliveries(chat, bob.did.uri)).toBe(0);
    }, 30000);

    it('reports a seal-coverage failure for a delegate on a mint-required path', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob DelegateMint', testDwnUrls });
      const delegate = await testHarness.agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Coverage-less Delegate' },
      });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);

      // No audience exists for the tuple, so provisioning must MINT one — which a
      // delegate without covering grantKey material cannot do. Fails closed with
      // the coverage reason and no audience record left behind.
      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : threadContextId,
        granteeDid             : delegate.did.uri,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : await randomX25519PublicKey(),
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      });

      expect(outcome.delivered).toBe(false);
      expect(!outcome.delivered && outcome.reason).toMatch(/without seal coverage/i);
      expect(await queryAudienceKeyIds(chat, threadContextId)).toHaveLength(0);
    }, 30000);

    it('throws on caller misuse instead of reporting a failed outcome', async () => {
      const chat = chatProtocolDefinition();

      // A nested role path with no contextId cannot address an audience tuple.
      await expect(testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        protocol     : chat.protocol,
        recipientDid : alice.did.uri,
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      })).rejects.toThrow(/contextId that reaches the parent context/i);

      // A malformed supplied key is rejected up front (pre-write validation), the
      // same way processRequest rejects it — never laundered into { delivered: false }.
      const ed25519Key = { crv: 'Ed25519', kty: 'OKP', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' } as unknown as PublicKeyJwk;
      await expect(testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : 'some-thread-context',
        protocol               : chat.protocol,
        recipientDid           : alice.did.uri,
        recipientRolePublicKey : ed25519Key,
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      })).rejects.toThrow(/X25519 OKP public key/i);
    });
  });
});
