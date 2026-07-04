import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  EncryptionProtocol,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

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
      admin : { $role: true, $actions: [{ who: 'anyone', can: ['read'] }] },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };
}

describe('AgentDwnApi sealed audience keys', () => {
  let testHarness: PlatformAgentTestHarness;
  let ownerDid: string;

  async function queryAudienceRecords(): Promise<RecordsWriteMessage[]> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : PROTOCOL_URI,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol  : PROTOCOL_URI,
            rolePath  : 'admin',
            contextId : '',
          },
        },
      },
    });

    expect(reply.status.code).toBe(200);
    return reply.entries as RecordsWriteMessage[] ?? [];
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

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: definition() },
      encryption    : true,
    });
    expect(reply.status.code).toBe(202);
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
});
