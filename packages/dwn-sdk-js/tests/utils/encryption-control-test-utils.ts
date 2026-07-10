import type { Persona } from './test-data-generator.js';
import type { DataEncodedRecordsWriteMessage, Dwn, ProtocolDefinition, ProtocolRuleSet } from '../../src/index.js';

import { expect } from 'bun:test';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { TestDataGenerator } from './test-data-generator.js';
import { Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from '../../src/core/constants.js';
import { Protocols, RecordsWrite } from '../../src/index.js';

export type AudienceControlWrite = {
  dataBytes: Uint8Array;
  keyId: string;
  payload: Record<string, unknown>;
  recordsWrite: RecordsWrite;
};

export async function installEncryptedProtocol(
  dwn: Dwn,
  author: Persona,
  protocolDefinition: ProtocolDefinition,
): Promise<ProtocolDefinition> {
  const encryptedProtocolDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
    protocolDefinition, TestDataGenerator.createProtocolPathKeyDeriver(author.keyId, author.encryptionKeyPair.privateJwk)
  );
  const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
    author,
    protocolDefinition: encryptedProtocolDefinition,
  });
  expect((await dwn.processMessage(author.did, protocolConfig.message)).status.code).toBe(202);

  return encryptedProtocolDefinition;
}

export async function createAudienceControlWrite(input: {
  author: Persona;
  contextId?: string;
  dateCreated?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  messageTimestamp?: string;
  payloadOverrides?: Record<string, unknown>;
  permissionGrantId?: string;
  protocol: string;
  protocolRole?: string;
  published?: boolean;
  recordId?: string;
  rolePath: string;
  roleRuleSet: ProtocolRuleSet;
  sealKeyId?: string;
  signer?: Persona;
  tags?: Record<string, string>;
}): Promise<AudienceControlWrite> {
  const audiencePublicKeyJwk = input.author.encryptionKeyPair.publicJwk;
  const audienceKeyId = await Encryption.getKeyId(audiencePublicKeyJwk);
  const sealKeyId = input.sealKeyId ?? await Encryption.getKeyId(input.roleRuleSet.$keyAgreement!.publicKeyJwk);
  const payload = {
    protocol         : input.protocol,
    rolePath         : input.rolePath,
    contextId        : input.contextId ?? '',
    keyId            : audienceKeyId,
    publicKeyJwk     : audiencePublicKeyJwk,
    sealedPrivateKey : {
      algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
      derivationScheme   : 'seal',
      keyId              : sealKeyId,
      ephemeralPublicKey : input.author.encryptionKeyPair.publicJwk,
      encryptedKey       : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(32)),
    },
    ...input.payloadOverrides,
  };
  const payloadKeyId = typeof payload.keyId === 'string' ? payload.keyId : audienceKeyId;
  const dataBytes = Encoder.objectToBytes(payload);
  const recordsWrite = await RecordsWrite.create({
    data              : dataBytes,
    dataFormat        : 'application/json',
    dateCreated       : input.dateCreated,
    delegatedGrant    : input.delegatedGrant,
    messageTimestamp  : input.messageTimestamp ?? input.dateCreated,
    permissionGrantId : input.permissionGrantId,
    protocol          : input.protocol,
    protocolPath      : ENCRYPTION_CONTROL_AUDIENCE_PATH,
    protocolRole      : input.protocolRole,
    published         : input.published,
    recordId          : input.recordId,
    schema            : 'https://identity.foundation/dwn/json-schemas/encryption/audience.json',
    signer            : Jws.createSigner(input.signer ?? input.author),
    tags              : {
      protocol  : input.protocol,
      rolePath  : input.rolePath,
      contextId : input.contextId ?? '',
      keyId     : payloadKeyId,
      ...input.tags,
    },
  });

  return {
    dataBytes,
    keyId: payloadKeyId,
    payload,
    recordsWrite,
  };
}

export async function createDeliveryControlWrite(input: {
  author: Persona;
  contextId?: string;
  keyId: string;
  protocol: string;
  recipient: string;
  recipientAuthority: string;
  rolePath: string;
  roleRuleSet: ProtocolRuleSet;
}): Promise<{ dataBytes: Uint8Array; recordsWrite: RecordsWrite }> {
  const tags: Record<string, string> = {
    protocol           : input.protocol,
    rolePath           : input.rolePath,
    contextId          : input.contextId ?? '',
    keyId              : input.keyId,
    recipientAuthority : input.recipientAuthority,
  };

  const dataBytes = Encoder.objectToBytes({
    protocol  : input.protocol,
    rolePath  : input.rolePath,
    contextId : input.contextId ?? '',
    keyId     : input.keyId,
  });
  const recordsWrite = await RecordsWrite.create({
    data            : dataBytes,
    dataFormat      : 'application/json',
    encryptionInput : {
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        keyId            : await Encryption.getKeyId(input.roleRuleSet.$keyAgreement!.publicKeyJwk),
        publicKey        : input.roleRuleSet.$keyAgreement!.publicKeyJwk,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
      }],
    },
    protocol     : input.protocol,
    protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
    recipient    : input.recipient,
    schema       : 'https://identity.foundation/dwn/json-schemas/encryption/delivery.json',
    signer       : Jws.createSigner(input.author),
    tags,
  });

  return { dataBytes, recordsWrite };
}

export async function processControlWrite(
  dwn: Dwn,
  tenant: string,
  controlWrite: { dataBytes: Uint8Array; recordsWrite: RecordsWrite },
): Promise<void> {
  const reply = await dwn.processMessage(tenant, controlWrite.recordsWrite.message, {
    dataStream: DataStream.fromBytes(controlWrite.dataBytes),
  });
  expect(reply.status.code).toBe(202);
}
