import type { ModuleDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { X25519 } from '@enbox/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  EncryptionControlDeliveryRecipientAuthority,
  getRuleSetAtPath,
  KeyDerivationScheme,
  Records,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  Time,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { buildFixedPrivateKeyDecrypter, createAudienceDeliveryRecord, resolveAudienceDecryptionKey } from '../src/dwn-encryption.js';

const testDwnUrls = [testDwnUrl];
const MODULE_URI = 'https://example.org/modules/sealed-audience-test';

function definition(): ModuleDefinition {
  return {
    published : true,
    module    : MODULE_URI,
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };
}

function nestedRootDefinition(): ModuleDefinition {
  return {
    published : true,
    module    : 'https://example.org/modules/sealed-audience-context-test',
    types     : {
      chat   : { dataFormats: ['text/plain'], encryptionRequired: true },
      member : { dataFormats: ['application/json'] },
    },
    structure: {
      chat: {
        $actions : [{ role: 'chat/member', can: ['read'] }],
        member   : { $role: true },
      },
    },
  };
}

function selfAnchoredNestedDefinition(): ModuleDefinition {
  return {
    published : true,
    module    : 'https://example.org/modules/sealed-audience-self-anchor-test',
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
          mod      : { $role: true },
        },
      },
    },
  };
}

describe('AgentDwnApi sealed audience keys', () => {
  let testHarness: PlatformAgentTestHarness;
  let ownerDid: string;

  async function installModule(tenantDid: string, moduleDefinition: ModuleDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ModulesConfigure,
      messageParams : { definition: moduleDefinition },
    });
    expect(reply.status.code).toBe(202);
  }

  async function queryAudienceRecords(params: {
    module?: string;
    rolePath?: string;
    contextId?: string;
  } = {}): Promise<RecordsWriteMessage[]> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          module     : params.module ?? MODULE_URI,
          modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags       : {
            module    : params.module ?? MODULE_URI,
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

  async function createRoleHolderDelivery(): Promise<{
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
      module       : MODULE_URI,
      contextId    : '',
      rolePath     : 'admin',
      keyId        : audiencePayload.keyId,
    });
    expect(resolvedOwnerKey).toBeDefined();

    const recipient = await testHarness.createIdentity({ name: 'Role Holder Recipient', testDwnUrls });
    await installModule(recipient.did.uri, definition());
    const { reply: roleReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : MODULE_URI,
        modulePath : 'admin',
        recipient  : recipient.did.uri,
        dataFormat : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(roleReply.status.code).toBe(202);

    const { reply: recipientModuleReply } = await testHarness.agent.dwn.processRequest({
      author        : recipient.did.uri,
      target        : recipient.did.uri,
      messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: MODULE_URI } },
    });
    const recipientDefinition = recipientModuleReply.entries![0].descriptor.definition;
    const recipientRolePublicKey = getRuleSetAtPath('admin', recipientDefinition.structure)!.$keyAgreement!.publicKeyJwk;

    const deliveryRecord = await createAudienceDeliveryRecord({
      agent       : testHarness.agent,
      audienceKey : {
        contextId   : '',
        keyId       : audiencePayload.keyId,
        keyMaterial : resolvedOwnerKey!.keyMaterial,
        module      : MODULE_URI,
        rolePath    : 'admin',
      },
      authorDid              : ownerDid,
      recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
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

  async function writeEncryptedNote(data: string): Promise<RecordsWriteMessage> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : MODULE_URI,
        modulePath : 'note',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode(data),
      },
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

    await installModule(ownerDid, definition());
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

    expect(audienceRecord.descriptor.module).toBe(MODULE_URI);
    expect(audienceRecord.descriptor.modulePath).toBe(ENCRYPTION_CONTROL_AUDIENCE_PATH);
    expect(audienceRecord.descriptor.tags).toMatchObject({
      module    : MODULE_URI,
      rolePath  : 'admin',
      contextId : '',
      keyId     : payload.keyId,
    });
    expect(payload).toMatchObject({
      module    : MODULE_URI,
      rolePath  : 'admin',
      contextId : '',
      keyId     : payload.keyId,
    });
    expect(payload.sealedPrivateKey.derivationScheme).toBe('seal');

    const roleAudienceEntry = write.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;
    expect(roleAudienceEntry).toMatchObject({
      module           : MODULE_URI,
      rolePath         : 'admin',
      keyId            : payload.keyId,
      derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
    });
    expect(roleAudienceEntry.epoch).toBeUndefined();
    expect(roleAudienceEntry.role).toBeUndefined();
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
  });

  it('mints a pending audience before writing an encrypted root context for a nested read role', async () => {
    const moduleDefinition = nestedRootDefinition();
    await installModule(ownerDid, moduleDefinition);

    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : moduleDefinition.module,
        modulePath : 'chat',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode('root chat'),
        published  : true,
      },
    });

    expect(reply.status.code).toBe(202);
    const chatWrite = message as RecordsWriteMessage;
    const audienceRecords = await queryAudienceRecords({
      contextId : chatWrite.recordId,
      module    : moduleDefinition.module,
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
      module   : moduleDefinition.module,
      rolePath : 'chat/member',
    });
  });

  it('mints and reuses an audience for a nested self-anchoring role context', async () => {
    const moduleDefinition = selfAnchoredNestedDefinition();
    await installModule(ownerDid, moduleDefinition);

    const { reply: chatReply, message: chatMessage } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : moduleDefinition.module,
        modulePath : 'chat',
        dataFormat : 'text/plain',
        data       : new TextEncoder().encode('chat root'),
      },
    });
    expect([202, 204]).toContain(chatReply.status.code);

    const chatWrite = chatMessage as RecordsWriteMessage;
    const { reply: threadReply, message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module          : moduleDefinition.module,
        modulePath      : 'chat/thread',
        parentContextId : chatWrite.recordId,
        dataFormat      : 'text/plain',
        data            : new TextEncoder().encode('thread body'),
      },
    });

    expect(threadReply.status.code).toBe(202);
    const threadWrite = threadMessage as RecordsWriteMessage;
    const contextId = `${chatWrite.recordId}/${threadWrite.recordId}`;
    const audienceRecords = await queryAudienceRecords({
      contextId,
      module   : moduleDefinition.module,
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
      module   : moduleDefinition.module,
      rolePath : 'chat/thread/mod',
    });

    await Time.minimalSleep();
    const { reply: updateReply, message: updateMessage } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module          : moduleDefinition.module,
        modulePath      : 'chat/thread',
        parentContextId : chatWrite.recordId,
        recordId        : threadWrite.recordId,
        dateCreated     : threadWrite.descriptor.dateCreated,
        dataFormat      : 'text/plain',
        data            : new TextEncoder().encode('updated thread body'),
      },
    });

    expect(updateReply.status.code).toBe(202);
    const updatedThread = updateMessage as RecordsWriteMessage;
    expect(updatedThread.descriptor.messageTimestamp > threadWrite.descriptor.messageTimestamp).toBeTrue();
    const updatedRoleAudienceEntry = updatedThread.encryption?.keyEncryption.find(
      (entry: any): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME,
    ) as any;
    expect(updatedRoleAudienceEntry.keyId).toBe(audiencePayload.keyId);
    expect(await queryAudienceRecords({
      contextId,
      module   : moduleDefinition.module,
      rolePath : 'chat/thread/mod',
    })).toHaveLength(1);
  });

  it('hydrates a roleHolder delivery for an active role holder', async () => {
    const { audiencePayload, recipientDid } = await createRoleHolderDelivery();

    const resolvedRecipientKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      contextId    : '',
      keyId        : audiencePayload.keyId,
      module       : MODULE_URI,
      recipientDid : recipientDid,
      rolePath     : 'admin',
      sourceDid    : ownerDid,
    });

    expect(resolvedRecipientKey?.keyMaterial.keyId).toBe(audiencePayload.keyId);
  });

  it('decrypts a roleHolder delivery wrapped to a supplied recipient key', async () => {
    const audienceRecord = await ensureRootAudienceRecord();
    const audiencePayload = Encoder.base64UrlToObject(audienceRecord.encodedData!) as any;
    const resolvedOwnerKey = await resolveAudienceDecryptionKey({
      agent        : testHarness.agent,
      sourceDid    : ownerDid,
      recipientDid : ownerDid,
      module       : MODULE_URI,
      contextId    : '',
      rolePath     : 'admin',
      keyId        : audiencePayload.keyId,
    });
    expect(resolvedOwnerKey).toBeDefined();

    const recipient = await testHarness.createIdentity({ name: 'Supplied Key Recipient', testDwnUrls });
    const { reply: roleReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        module     : MODULE_URI,
        modulePath : 'admin',
        recipient  : recipient.did.uri,
        dataFormat : 'application/json',
      },
      dataStream: new Blob(['{}']),
    });
    expect(roleReply.status.code).toBe(202);

    const suppliedPrivateKey = await X25519.generateKey();
    const suppliedPublicKey = await X25519.getPublicKey({ key: suppliedPrivateKey });
    const suppliedKeyId = await Encryption.getKeyId(suppliedPublicKey);
    const deliveryRecord = await createAudienceDeliveryRecord({
      agent       : testHarness.agent,
      audienceKey : {
        contextId   : '',
        keyId       : audiencePayload.keyId,
        keyMaterial : resolvedOwnerKey!.keyMaterial,
        module      : MODULE_URI,
        rolePath    : 'admin',
      },
      authorDid              : ownerDid,
      recipientAuthority     : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
      recipientDid           : recipient.did.uri,
      recipientRolePublicKey : suppliedPublicKey as any,
      sourceDid              : ownerDid,
    }) as RecordsWriteMessage & { encodedData: string };

    const decryptedStream = await Records.decrypt(
      deliveryRecord,
      buildFixedPrivateKeyDecrypter({
        derivationScheme : KeyDerivationScheme.ModulePath,
        keyId            : suppliedKeyId,
        privateKeyJwk    : suppliedPrivateKey as any,
        publicKeyJwk     : suppliedPublicKey as any,
      }),
      DataStream.fromBytes(Encoder.base64UrlToBytes(deliveryRecord.encodedData)),
    );
    const deliveryPayload = Encoder.bytesToObject(await DataStream.toBytes(decryptedStream)) as any;

    expect(deliveryRecord.descriptor.tags).toMatchObject({
      module             : MODULE_URI,
      rolePath           : 'admin',
      contextId          : '',
      keyId              : audiencePayload.keyId,
      recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
    });
    expect(deliveryPayload).toMatchObject({
      module    : MODULE_URI,
      rolePath  : 'admin',
      contextId : '',
      keyId     : audiencePayload.keyId,
    });
    expect(deliveryPayload.keyMaterial.privateKeyJwk.d).toBe(resolvedOwnerKey!.keyMaterial.privateKeyJwk.d);
  });

  it('fails closed when a delegated writer without seal coverage needs to mint an audience', async () => {
    // dedicated URI: the fails-closed premise is that no audience exists yet, so the shared
    // URI's audience records from earlier tests must not be in scope
    const mintDefinition: ModuleDefinition = {
      ...definition(),
      module: 'https://example.org/modules/sealed-audience-mint-test',
    };
    await installModule(ownerDid, mintDefinition);
    const delegate = await testHarness.createIdentity({ name: 'Audience Delegate', testDwnUrls });
    const writeGrant = await testHarness.agent.permissions.createGrant({
      author      : ownerDid,
      dateExpires : '2099-01-01T00:00:00.000000Z',
      delegated   : true,
      grantedTo   : delegate.did.uri,
      scope       : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        module    : mintDefinition.module,
      },
      store: true,
    });

    await expect(testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      granteeDid    : delegate.did.uri,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        delegatedGrant : writeGrant.message,
        module         : mintDefinition.module,
        modulePath     : 'note',
        dataFormat     : 'text/plain',
        data           : new TextEncoder().encode('delegate sealed note'),
      },
    })).rejects.toThrow('without seal coverage');
  });

  it('returns raw source-module delivery records in broad queries', async () => {
    const { deliveryRecord } = await createRoleHolderDelivery();
    await writeEncryptedNote('query with source-module delivery');

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { module: MODULE_URI } },
    });

    expect(reply.status.code).toBe(200);
    const deliveryEntry = reply.entries?.find((entry): boolean => entry.recordId === deliveryRecord.recordId);
    expect(deliveryEntry?.descriptor.modulePath).toBe(ENCRYPTION_CONTROL_DELIVERY_PATH);
    expect(deliveryEntry?.encodedData).toBe(deliveryRecord.encodedData);
  });
});
