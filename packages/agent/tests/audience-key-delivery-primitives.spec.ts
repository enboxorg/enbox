import type { PublicKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import type { AudienceKeyDeliveryOutcome } from '../src/types/dwn.js';
import type { AudienceKeyDeliveryState } from '../src/audience-key-delivery.js';
import type { BearerIdentity } from '../src/bearer-identity.js';

import sinon from 'sinon';
import { X25519 } from '@enbox/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionControlDeliveryRecipientAuthority,
  getRuleSetAtPath,
  Poller,
  Time,
} from '@enbox/dwn-sdk-js';

import { createImportedDelegateDid } from './utils/delegate-did.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { RemoteProtocolDefinitionError } from '../src/dwn-protocol-cache.js';
import { scanActiveAudienceKeyDeliveryIntents } from '../src/audience-key-delivery-reconciliation.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createAudienceDeliveryRecord, createGrantKeyRecordsForGrants, resolveAudienceDecryptionKey } from '../src/dwn-encryption.js';

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

  async function installProtocol(tenantDid: string, definition: ProtocolDefinition): Promise<ProtocolDefinition> {
    const { message, reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    expect(reply.status.code).toBe(202);
    return (message as ProtocolsConfigureMessage).descriptor.definition;
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
  ): Promise<{ roleContextId: string; roleRecordId: string; delivery?: AudienceKeyDeliveryOutcome }> {
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
      roleRecordId  : (response.message as RecordsWriteMessage).recordId,
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

  describe('audience-key delivery reconciliation', () => {
    it('rebuilds active role intent and removes it after the role is deleted', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Reconciled', testDwnUrls });
      const installedChat = await installProtocol(alice.did.uri, chat);
      await installProtocol(bob.did.uri, chat);
      const threadContextId = await writeThread(chat);
      const { roleRecordId } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      await testHarness.audienceKeyDeliveryStore.clear();

      const reconcile = async (): Promise<AudienceKeyDeliveryState[]> => testHarness.audienceKeyDeliveryStore.reconcileProtocol({
        protocol  : chat.protocol,
        sourceDid : alice.did.uri,
        scan      : () => scanActiveAudienceKeyDeliveryIntents({
          agent              : testHarness.agent,
          protocolDefinition : installedChat,
          sourceDid          : alice.did.uri,
        }),
      });

      expect(await reconcile()).toEqual([{
        contextId    : threadContextId,
        protocol     : chat.protocol,
        recipientDid : bob.did.uri,
        rolePath     : ROLE_PATH,
        roleRecordId,
        sourceDid    : alice.did.uri,
        state        : 'pending',
      }]);

      const { reply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsDelete,
        messageParams : { recordId: roleRecordId },
      });
      expect(reply.status.code).toBe(202);
      expect(await reconcile()).toEqual([]);
    }, 30000);
  });

  describe('automatic audience-key delivery', () => {
    it('uses only owned replication links to establish delivery-feed currentness', async () => {
      const protocol = 'https://protocol.test/delivery-currentness';
      sinon.stub(testHarness.agent.sync, 'getIdentityOptions').resolves({ protocols: [protocol] });
      const getLinks = sinon.stub(testHarness.agent.sync, 'getReplicationLinks');
      getLinks.onFirstCall().resolves([{
        tenantDid      : alice.did.uri,
        remoteEndpoint : testDwnUrls[0],
        scope          : { kind: 'protocolSet', protocols: [protocol] },
        status         : 'live',
        connectivity   : 'online',
        isPullCurrent  : true,
      }, {
        tenantDid        : alice.did.uri,
        remoteEndpoint   : testDwnUrls[0],
        scope            : { kind: 'context', protocol, contextId: 'sibling', protocolPaths: ['thread'] },
        status           : 'paused',
        connectivity     : 'offline',
        followedSourceId : 'sibling-role',
        isPullCurrent    : false,
      }]);
      getLinks.onSecondCall().resolves([{
        tenantDid        : alice.did.uri,
        remoteEndpoint   : testDwnUrls[0],
        scope            : { kind: 'context', protocol, contextId: 'shared', protocolPaths: ['thread'] },
        status           : 'live',
        connectivity     : 'online',
        followedSourceId : 'shared-role',
        isPullCurrent    : true,
      }]);

      await expect((testHarness.agent.dwn as any).assertAudienceKeyDeliveryFeedCurrent(
        alice.did.uri,
        protocol,
      )).resolves.toBeUndefined();
      await expect((testHarness.agent.dwn as any).assertAudienceKeyDeliveryFeedCurrent(
        alice.did.uri,
        protocol,
      )).rejects.toThrow('waiting for the local replica to become current');
    });

    it('reconciles from the installed definition instead of treating authored wake paths as authority', async () => {
      const chat = chatProtocolDefinition();
      chat.types.retired = { dataFormats: ['application/json'] };
      (chat.structure.thread as ProtocolRuleSet).retired = { $role: true };
      await installProtocol(alice.did.uri, chat);
      const reconcile = sinon.spy(testHarness.audienceKeyDeliveryStore, 'reconcileProtocol');

      const retry = await (testHarness.agent.dwn as any).runAudienceKeyDeliveryPass({
        protocol : chat.protocol,
        signal   : new AbortController().signal,
        target   : alice.did.uri,
      }, true);

      expect(retry).toBe(false);
      expect(reconcile.calledOnce).toBe(true);
    }, 30000);

    it('waits for a current replica, repairs after recipient install, and removes deleted roles', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Automatic Repair', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);
      const { delivery, roleRecordId } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery).toMatchObject({ delivered: false, failure: 'awaiting-recipient-install' });
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(await testHarness.audienceKeyDeliveryStore.get(alice.did.uri, roleRecordId))
          .toMatchObject({ state: 'awaiting-recipient-install' });
      });

      sinon.stub(testHarness.agent.sync, 'getIdentityOptions').resolves({ protocols: [chat.protocol] });
      const link = {
        tenantDid      : alice.did.uri,
        remoteEndpoint : testDwnUrls[0],
        scope          : { kind: 'protocolSet' as const, protocols: [chat.protocol] as [string] },
        status         : 'live' as const,
      };
      let connectivity: 'offline' | 'online' = 'offline';
      const currentReads: boolean[] = [];
      const getLinks = sinon.stub(testHarness.agent.sync, 'getReplicationLinks').callsFake(async () => [
        { ...link, connectivity, isPullCurrent: currentReads.shift() ?? true },
      ]);
      const reprovision = sinon.spy(testHarness.agent.dwn, 'reprovisionAudienceKeyDelivery');
      const pullCurrentEvent = {
        type           : 'pull:currentness-change',
        tenantDid      : alice.did.uri,
        remoteEndpoint : testDwnUrls[0],
        protocol       : chat.protocol,
        from           : false,
        to             : true,
      } as const;

      const session = new AbortController();
      testHarness.agent.dwn.registerAudienceKeyDeliveryProtocol({
        protocol  : chat.protocol,
        rolePaths : [ROLE_PATH],
        signal    : session.signal,
        target    : alice.did.uri,
      });
      await Poller.pollUntilSuccessOrTimeout(async () => { expect(getLinks.called).toBe(true); });
      expect(reprovision.notCalled).toBe(true);

      connectivity = 'online';
      currentReads.push(true, false);
      (testHarness.agent.sync as any).emitEvent(pullCurrentEvent);
      await Poller.pollUntilSuccessOrTimeout(async () => { expect(currentReads).toHaveLength(0); });
      expect(reprovision.notCalled).toBe(true);

      currentReads.push(false);
      (testHarness.agent.sync as any).emitEvent({
        ...pullCurrentEvent,
        type : 'link:connectivity-change',
        from : 'offline',
        to   : 'online',
      });
      await Poller.pollUntilSuccessOrTimeout(async () => { expect(currentReads).toHaveLength(0); });
      (testHarness.agent.sync as any).emitEvent(pullCurrentEvent);
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(reprovision.calledOnce).toBe(true);
      });
      expect(await testHarness.audienceKeyDeliveryStore.get(alice.did.uri, roleRecordId))
        .toMatchObject({ state: 'awaiting-recipient-install' });

      await installProtocol(bob.did.uri, chat);
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(await testHarness.audienceKeyDeliveryStore.get(alice.did.uri, roleRecordId))
          .toMatchObject({ state: 'delivered' });
      });

      const { reply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsDelete,
        messageParams : { recordId: roleRecordId },
      });
      expect(reply.status.code).toBe(202);
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(await testHarness.audienceKeyDeliveryStore.get(alice.did.uri, roleRecordId)).toBeUndefined();
      });
      session.abort();
    }, 30000);

    it('reads persisted state and explicitly retries dormant work through the session coordinator', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Explicit Repair', testDwnUrls });
      await installProtocol(alice.did.uri, chat);
      const threadContextId = await writeThread(chat);
      const roleKey = sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
        .rejects(new RemoteProtocolDefinitionError('recipient protocol not installed', 'not-found'));
      const { roleRecordId } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      const session = new AbortController();
      testHarness.agent.dwn.registerAudienceKeyDeliveryProtocol({
        protocol  : chat.protocol,
        rolePaths : [ROLE_PATH],
        signal    : session.signal,
        target    : alice.did.uri,
      });
      await Poller.pollUntilSuccessOrTimeout(async () => {
        expect(await testHarness.agent.dwn.getAudienceKeyDeliveryState({
          protocol : chat.protocol,
          roleRecordId,
          signal   : session.signal,
          target   : alice.did.uri,
        })).toMatchObject({ state: 'awaiting-recipient-install' });
      });
      await expect(testHarness.agent.dwn.getAudienceKeyDeliveryState({
        protocol : chat.protocol,
        roleRecordId,
        signal   : new AbortController().signal,
        target   : alice.did.uri,
      })).rejects.toThrow('no audience-key delivery coordinator');

      await Poller.pollUntilSuccessOrTimeout(async () => { expect(roleKey.callCount).toBeGreaterThan(1); });
      const projected = await testHarness.audienceKeyDeliveryStore.get(alice.did.uri, roleRecordId);
      expect(projected).toBeDefined();
      await testHarness.audienceKeyDeliveryStore.record({
        intent  : projected!,
        outcome : { delivered: false, failure: 'terminal', reason: 'authorization was repaired', recipientDid: bob.did.uri },
      });
      roleKey.resolves(await randomX25519PublicKey());

      expect(await testHarness.agent.dwn.getAudienceKeyDeliveryState({
        protocol : chat.protocol,
        roleRecordId,
        signal   : session.signal,
        target   : alice.did.uri,
      })).toMatchObject({ state: 'failed' });
      expect(await testHarness.agent.dwn.retryAudienceKeyDeliveryState({
        protocol : chat.protocol,
        roleRecordId,
        signal   : session.signal,
        target   : alice.did.uri,
      })).toMatchObject({ state: 'delivered' });
      session.abort();
      await expect(testHarness.agent.dwn.getAudienceKeyDeliveryState({
        protocol : chat.protocol,
        roleRecordId,
        signal   : session.signal,
        target   : alice.did.uri,
      })).rejects.toThrow();
    }, 30000);
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
      expect(!outcome.delivered && outcome.failure).toBe('retryable');
      expect(!outcome.delivered && outcome.reason).toMatch(/unresolvable in test/i);
    }, 30000);

    it('reports when the recipient has not installed the protocol', async () => {
      const dwnApi = testHarness.agent.dwn as any;
      sinon.stub(dwnApi, 'getProtocolDefinition').resolves(undefined);
      sinon.stub(dwnApi, 'fetchRemoteProtocolDefinition').rejects(
        new RemoteProtocolDefinitionError('protocol not installed', 'not-found'),
      );

      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId    : 'thread-context',
        protocol     : 'https://protocol.example/chat',
        recipientDid : 'did:example:recipient',
        rolePath     : ROLE_PATH,
        target       : alice.did.uri,
      });

      expect(outcome).toEqual({
        delivered    : false,
        failure      : 'awaiting-recipient-install',
        reason       : 'protocol not installed',
        recipientDid : 'did:example:recipient',
      });
    });

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
            failure      : 'retryable',
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

    it('resolves a delegate write grant and repairs delivery', async () => {
      const chat = chatProtocolDefinition();
      const bob = await testHarness.createIdentity({ name: 'Bob Delegate Repair', testDwnUrls });
      await installProtocol(alice.did.uri, chat);

      const roleKeyStub = stubUnresolvableRecipientKey();
      const threadContextId = await writeThread(chat);
      const { roleContextId, delivery } = await writeRoleRecord(chat, threadContextId, bob.did.uri);
      expect(delivery?.delivered).toBe(false);
      roleKeyStub.restore();
      expect(await countDeliveries(chat, bob.did.uri)).toBe(0);

      await installProtocol(bob.did.uri, chat);
      const bobRoleKey = await readRolePublicKey(bob.did.uri, chat.protocol);

      const { delegateDid, delegateX25519PrivateKey } = await createImportedDelegateDid(testHarness);
      const writeGrant = await testHarness.agent.permissions.createGrant({
        author      : alice.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 300 }),
        delegated   : true,
        grantedTo   : delegateDid,
        scope       : {
          interface    : DwnInterfaceName.Records,
          method       : DwnMethodName.Write,
          protocol     : chat.protocol,
          protocolPath : ROLE_PATH,
        },
        store: true,
      });
      const { encodedData, ...grantMessage } = writeGrant.message;
      const grantCopy = await testHarness.agent.processDwnRequest({
        author      : delegateDid,
        target      : delegateDid,
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : grantMessage,
        dataStream  : new Blob([Encoder.base64UrlToBytes(encodedData)]),
        signAsOwner : true,
      });
      expect(grantCopy.reply.status.code).toBe(202);
      await createGrantKeyRecordsForGrants({
        agent                 : testHarness.agent,
        granteeDid            : delegateDid,
        granteeRootPrivateKey : delegateX25519PrivateKey,
        grantMessages         : [writeGrant.message],
        ownerDid              : alice.did.uri,
      });
      testHarness.agent.dwn.clearDelegateDecryptionKeys(delegateDid);

      const permissionLookup = sinon.spy(testHarness.agent.permissions, 'getPermissionForRequest');
      const outcome = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery({
        contextId              : roleContextId,
        granteeDid             : delegateDid,
        protocol               : chat.protocol,
        recipientDid           : bob.did.uri,
        recipientRolePublicKey : bobRoleKey,
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      });
      expect(outcome).toEqual({ delivered: true, recipientDid: bob.did.uri });
      const writeLookups = permissionLookup.getCalls().filter(
        (call): boolean => call.args[0].messageType === DwnInterface.RecordsWrite,
      );
      expect(writeLookups).toHaveLength(1);
      expect(writeLookups[0].args[0]).toEqual({
        connectedDid : alice.did.uri,
        delegate     : true,
        delegateDid,
        messageType  : DwnInterface.RecordsWrite,
        protocol     : chat.protocol,
        protocolPath : ROLE_PATH,
      });
      expect(await countDeliveries(chat, bob.did.uri)).toBe(1);
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
      expect(!outcome.delivered && outcome.failure).toBe('terminal');
      expect(!outcome.delivered && outcome.reason).toMatch(/role record is missing/i);
      expect(await countDeliveries(chat, bob.did.uri)).toBe(0);
    }, 30000);

    it('resolves delegated authorization on every repair attempt', async () => {
      const chat = chatProtocolDefinition();
      const delegate = await testHarness.agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Coverage-less Delegate' },
      });

      const permissionLookup = sinon.spy(testHarness.agent.permissions, 'getPermissionForRequest');
      const request = {
        contextId              : 'thread-context',
        granteeDid             : delegate.did.uri,
        protocol               : chat.protocol,
        protocolRole           : ROLE_PATH,
        recipientDid           : 'did:example:recipient',
        recipientRolePublicKey : await randomX25519PublicKey(),
        rolePath               : ROLE_PATH,
        target                 : alice.did.uri,
      };
      const first = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request);
      const second = await testHarness.agent.dwn.reprovisionAudienceKeyDelivery(request);

      expect(first.delivered).toBe(false);
      expect(!first.delivered && first.failure).toBe('terminal');
      expect(!first.delivered && first.reason).toMatch(/no matching permission grant/i);
      expect(second.delivered).toBe(false);
      expect(permissionLookup.callCount).toBe(2);
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
