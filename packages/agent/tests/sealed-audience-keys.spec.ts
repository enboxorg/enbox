import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionControlDeliveryRecipientAuthority,
  EncryptionProtocol,
  getRuleSetAtPath,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createAudienceDeliveryRecord, resolveAudienceDecryptionKey } from '../src/dwn-encryption.js';

const testDwnUrls = [testDwnUrl];
const PROTOCOL_URI = 'https://example.org/protocols/sealed-audience-test';

function definition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : PROTOCOL_URI,
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true, $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };
}

function nestedRootDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : 'https://example.org/protocols/sealed-audience-context-test',
    types     : {
      chat   : { dataFormats: ['text/plain'], encryptionRequired: true },
      member : { dataFormats: ['application/json'] },
    },
    structure: {
      chat: {
        $actions : [{ role: 'chat/member', can: ['read'] }],
        member   : { $role: true, $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
      },
    },
  };
}

function selfAnchoredNestedDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : 'https://example.org/protocols/sealed-audience-self-anchor-test',
    types     : {
      chat   : { dataFormats: ['text/plain'] },
      mod    : { dataFormats: ['application/json'] },
      thread : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      chat: {
        $actions : [{ who: 'anyone', can: ['create', 'read'] }],
        thread   : {
          $actions : [{ role: 'chat/thread/mod', can: ['read'] }],
          mod      : { $role: true, $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
        },
      },
    },
  };
}

function delegatedFallbackDefinition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : 'https://example.org/protocols/sealed-audience-delegate-fallback-test',
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true, $actions: [{ who: 'anyone', can: ['create', 'read'] }] },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };
}

describe('AgentDwnApi sealed audience keys', () => {
  let testHarness: PlatformAgentTestHarness;
  let ownerDid: string;

  async function installProtocol(tenantDid: string, protocolDefinition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocolDefinition },
      encryption    : true,
    });
    expect(reply.status.code).toBe(202);
  }

  async function queryAudienceRecords(params: {
    protocol?: string;
    rolePath?: string;
    contextId?: string;
  } = {}): Promise<RecordsWriteMessage[]> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : params.protocol ?? PROTOCOL_URI,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol  : params.protocol ?? PROTOCOL_URI,
            rolePath  : params.rolePath ?? 'admin',
            contextId : params.contextId ?? '',
          },
        },
      },
    });

    expect(reply.status.code).toBe(200);
    return reply.entries as RecordsWriteMessage[] ?? [];
  }

  async function ensureRootAudienceRecord(): Promise<RecordsWriteMessage> {
    const existing = await queryAudienceRecords();
    if (existing.length > 0) {
      return existing[0];
    }

    await writeEncryptedNote('seed sealed note');
    return (await queryAudienceRecords())[0];
  }

  async function createRoleCreatorAnyoneDelivery(): Promise<{
    audiencePayload: any;
    deliveryRecord: RecordsWriteMessage;
    recipientDid: string;
  }> {
    const audienceRecord = await ensureRootAudienceRecord();
    const audiencePayload = Encoder.base64UrlToObject(audienceRecord.encodedData!) as any;
    const resolvedOwnerKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      sourceDid    : ownerDid,
      recipientDid : ownerDid,
      protocol     : PROTOCOL_URI,
      contextId    : '',
      rolePath     : 'admin',
      keyId        : audiencePayload.keyId,
    });
    expect(resolvedOwnerKey).toBeDefined();

    const recipient = await testHarness.createIdentity({ name: 'Role Creator Recipient', testDwnUrls });
    await installProtocol(recipient.did.uri, definition());
    const { reply: recipientProtocolReply } = await testHarness.agent.dwn.processRequest({
      author        : recipient.did.uri,
      target        : recipient.did.uri,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: PROTOCOL_URI } },
    });
    const recipientDefinition = recipientProtocolReply.entries![0].descriptor.definition;
    const recipientRolePublicKey = getRuleSetAtPath('admin', recipientDefinition.structure)!.$keyAgreement!.publicKeyJwk;

    const deliveryRecord = await createAudienceDeliveryRecord({
      agent       : testHarness.agent,
      audienceKey : {
        contextId   : '',
        keyId       : audiencePayload.keyId,
        keyMaterial : resolvedOwnerKey!.keyMaterial,
        protocol    : PROTOCOL_URI,
        rolePath    : 'admin',
      },
      authorDid              : ownerDid,
      recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleCreatorAnyone,
      recipientDid           : recipient.did.uri,
      recipientRolePublicKey : recipientRolePublicKey as any,
      sourceDid              : ownerDid,
    });

    return {
      audiencePayload,
      deliveryRecord : deliveryRecord as RecordsWriteMessage,
      recipientDid   : recipient.did.uri,
    };
  }

  async function countLegacyAudienceEpochs(): Promise<number> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: EncryptionProtocol.uri, protocolPath: EncryptionProtocol.audienceEpochPath },
      },
    });
    return reply.entries?.length ?? 0;
  }

  async function writeEncryptedNote(data: string): Promise<RecordsWriteMessage> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : PROTOCOL_URI,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode(data),
      },
      encryption: true,
    });

    expect(reply.status.code).toBe(202);
    return message as RecordsWriteMessage;
  }

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({ agentClass: TestAgent, agentStores: 'memory' });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const owner = await testHarness.createIdentity({ name: 'Owner', testDwnUrls });
    ownerDid = owner.did.uri;

    await installProtocol(ownerDid, definition());
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('mints a sealed audience record before writing a role-readable encrypted record', async () => {
    const write = await writeEncryptedNote('first sealed note');
    const audienceRecords = await queryAudienceRecords();

    expect(audienceRecords).toHaveLength(1);
    const audienceRecord = audienceRecords[0];
    const payload = Encoder.base64UrlToObject(audienceRecord.encodedData!) as any;

    expect(audienceRecord.descriptor.protocol).toBe(PROTOCOL_URI);
    expect(audienceRecord.descriptor.protocolPath).toBe(ENCRYPTION_CONTROL_AUDIENCE_PATH);
    expect(audienceRecord.descriptor.tags).toMatchObject({
      protocol  : PROTOCOL_URI,
      rolePath  : 'admin',
      contextId : '',
      keyId     : payload.keyId,
    });
    expect(payload).toMatchObject({
      protocol  : PROTOCOL_URI,
      rolePath  : 'admin',
      contextId : '',
      keyId     : payload.keyId,
    });
    expect(payload.sealedPrivateKey.derivationScheme).toBe('seal');

    const roleAudienceEntry = write.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;
    expect(roleAudienceEntry).toMatchObject({
      protocol         : PROTOCOL_URI,
      rolePath         : 'admin',
      keyId            : payload.keyId,
      derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
    });
    expect(roleAudienceEntry.epoch).toBeUndefined();
    expect(roleAudienceEntry.role).toBeUndefined();
    expect(await countLegacyAudienceEpochs()).toBe(0);
  });

  it('is mint-if-absent and reuses the current audience key for later writes', async () => {
    const firstAudience = (await queryAudienceRecords())[0];
    const firstPayload = Encoder.base64UrlToObject(firstAudience.encodedData!) as any;

    const secondWrite = await writeEncryptedNote('second sealed note');
    const audienceRecords = await queryAudienceRecords();
    const secondRoleAudienceEntry = secondWrite.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;

    expect(audienceRecords).toHaveLength(1);
    expect(secondRoleAudienceEntry.keyId).toBe(firstPayload.keyId);
    expect(await countLegacyAudienceEpochs()).toBe(0);
  });

  it('mints a pending audience before writing an encrypted root context for a nested read role', async () => {
    const protocolDefinition = nestedRootDefinition();
    await installProtocol(ownerDid, protocolDefinition);

    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode('root chat'),
        published    : true,
      },
      encryption: true,
    });

    expect(reply.status.code).toBe(202);
    const chatWrite = message as RecordsWriteMessage;
    const audienceRecords = await queryAudienceRecords({
      contextId : chatWrite.recordId,
      protocol  : protocolDefinition.protocol,
      rolePath  : 'chat/member',
    });
    expect(audienceRecords).toHaveLength(1);

    const audiencePayload = Encoder.base64UrlToObject(audienceRecords[0].encodedData!) as any;
    const roleAudienceEntry = chatWrite.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;
    expect(audiencePayload.contextId).toBe(chatWrite.recordId);
    expect(roleAudienceEntry).toMatchObject({
      keyId    : audiencePayload.keyId,
      protocol : protocolDefinition.protocol,
      rolePath : 'chat/member',
    });
  });

  it('mints a pending audience for a nested self-anchoring role context', async () => {
    const protocolDefinition = selfAnchoredNestedDefinition();
    await installProtocol(ownerDid, protocolDefinition);

    const { reply: chatReply, message: chatMessage } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : protocolDefinition.protocol,
        protocolPath : 'chat',
        dataFormat   : 'text/plain',
        data         : new TextEncoder().encode('chat root'),
      },
    });
    expect([202, 204]).toContain(chatReply.status.code);

    const chatWrite = chatMessage as RecordsWriteMessage;
    const { reply: threadReply, message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'chat/thread',
        parentContextId : chatWrite.recordId,
        dataFormat      : 'text/plain',
        data            : new TextEncoder().encode('thread body'),
      },
      encryption: true,
    });

    expect(threadReply.status.code).toBe(202);
    const threadWrite = threadMessage as RecordsWriteMessage;
    const contextId = `${chatWrite.recordId}/${threadWrite.recordId}`;
    const audienceRecords = await queryAudienceRecords({
      contextId,
      protocol : protocolDefinition.protocol,
      rolePath : 'chat/thread/mod',
    });
    expect(audienceRecords).toHaveLength(1);

    const audiencePayload = Encoder.base64UrlToObject(audienceRecords[0].encodedData!) as any;
    const roleAudienceEntry = threadWrite.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;
    expect(audiencePayload.contextId).toBe(contextId);
    expect(roleAudienceEntry).toMatchObject({
      keyId    : audiencePayload.keyId,
      protocol : protocolDefinition.protocol,
      rolePath : 'chat/thread/mod',
    });
  });

  it('hydrates a roleCreatorAnyone delivery without requiring a role-holder record', async () => {
    const { audiencePayload, recipientDid } = await createRoleCreatorAnyoneDelivery();

    const resolvedRecipientKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      contextId    : '',
      keyId        : audiencePayload.keyId,
      protocol     : PROTOCOL_URI,
      recipientDid : recipientDid,
      rolePath     : 'admin',
      sourceDid    : ownerDid,
    });

    expect(resolvedRecipientKey?.keyMaterial.keyId).toBe(audiencePayload.keyId);
  });

  it('writes a roleCreatorGrant self-delivery for delegated audience minters', async () => {
    const protocolDefinition = delegatedFallbackDefinition();
    await installProtocol(ownerDid, protocolDefinition);
    const delegate = await testHarness.createIdentity({ name: 'Audience Delegate', testDwnUrls });
    const writeGrant = await testHarness.agent.permissions.createGrant({
      author      : ownerDid,
      dateExpires : '2099-01-01T00:00:00.000000Z',
      delegated   : true,
      grantedTo   : delegate.did.uri,
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : protocolDefinition.protocol,
      },
      store: true,
    });

    const { reply: writeReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      granteeDid    : delegate.did.uri,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        delegatedGrant : writeGrant.message,
        protocol       : protocolDefinition.protocol,
        protocolPath   : 'note',
        dataFormat     : 'text/plain',
        data           : new TextEncoder().encode('delegate sealed note'),
      },
      encryption: true,
    });
    expect(writeReply.status.code).toBe(202);

    const audienceRecords = await queryAudienceRecords({
      contextId : '',
      protocol  : protocolDefinition.protocol,
      rolePath  : 'admin',
    });
    expect(audienceRecords).toHaveLength(1);
    const audiencePayload = Encoder.base64UrlToObject(audienceRecords[0].encodedData!) as any;

    const { reply: deliveryReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          recipient    : delegate.did.uri,
          protocol     : protocolDefinition.protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          tags         : {
            protocol  : protocolDefinition.protocol,
            rolePath  : 'admin',
            contextId : '',
            keyId     : audiencePayload.keyId,
          },
        },
      },
    });
    expect(deliveryReply.status.code).toBe(200);
    expect(deliveryReply.entries).toHaveLength(1);
    expect(deliveryReply.entries![0].descriptor.tags).toMatchObject({
      grantId            : writeGrant.message.recordId,
      recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleCreatorGrant,
    });

    const { reply: delegateDeliveryReply } = await testHarness.agent.dwn.processRequest({
      author        : delegate.did.uri,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          recipient    : delegate.did.uri,
          protocol     : protocolDefinition.protocol,
          protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
          tags         : {
            protocol  : protocolDefinition.protocol,
            rolePath  : 'admin',
            contextId : '',
            keyId     : audiencePayload.keyId,
          },
        },
      },
    });
    expect(delegateDeliveryReply.status.code).toBe(200);
    expect(delegateDeliveryReply.entries).toHaveLength(1);
    expect(typeof delegateDeliveryReply.entries![0].encodedData).toBe('string');

    const { reply: delegateGrantReply } = await testHarness.agent.dwn.processRequest({
      author        : delegate.did.uri,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: writeGrant.message.recordId } },
    });
    expect(delegateGrantReply.status.code).toBe(200);
    expect(delegateGrantReply.entry?.recordsWrite.recordId).toBe(writeGrant.message.recordId);

    const resolvedDelegateKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      contextId    : '',
      granteeDid   : delegate.did.uri,
      keyId        : audiencePayload.keyId,
      protocol     : protocolDefinition.protocol,
      recipientDid : ownerDid,
      rolePath     : 'admin',
      sourceDid    : ownerDid,
    });
    expect(resolvedDelegateKey?.keyMaterial.keyId).toBe(audiencePayload.keyId);
  });

  it('does not auto-decrypt source-protocol delivery records in broad encrypted queries', async () => {
    const { deliveryRecord } = await createRoleCreatorAnyoneDelivery();
    await writeEncryptedNote('query with source-protocol delivery');

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: PROTOCOL_URI } },
      encryption    : true,
    });

    expect(reply.status.code).toBe(200);
    const deliveryEntry = reply.entries?.find((entry): boolean => entry.recordId === deliveryRecord.recordId);
    expect(deliveryEntry?.descriptor.protocolPath).toBe(ENCRYPTION_CONTROL_DELIVERY_PATH);
    expect(deliveryEntry?.encodedData).toBe(deliveryRecord.encodedData);
  });
});
