import type { Persona } from './test-data-generator.js';
import type { DataEncodedRecordsWriteMessage, Dwn, ModuleDefinition, ModuleRuleSet } from '../../src/index.js';

import { expect } from 'bun:test';

import { DataStream } from '../../src/utils/data-stream.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { TestDataGenerator } from './test-data-generator.js';
import { DwnInterfaceName, DwnMethodName, Modules, RecordsWrite } from '../../src/index.js';
import { Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from '../../src/core/constants.js';

export type AudienceControlWrite = {
  dataBytes: Uint8Array;
  keyId: string;
  payload: Record<string, unknown>;
  recordsWrite: RecordsWrite;
};

export async function installEncryptedModule(
  dwn: Dwn,
  author: Persona,
  moduleDefinition: ModuleDefinition,
): Promise<ModuleDefinition> {
  const encryptedModuleDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
    moduleDefinition, TestDataGenerator.createModulePathKeyDeriver(author.keyId, author.encryptionKeyPair.privateJwk)
  );
  const moduleConfig = await TestDataGenerator.generateModulesConfigure({
    author,
    moduleDefinition: encryptedModuleDefinition,
  });
  expect((await dwn.processMessage(author.did, moduleConfig.message)).status.code).toBe(202);

  return encryptedModuleDefinition;
}

export async function grantModulePathWriteAccess(input: {
  dwn: Dwn;
  grantee: Persona;
  module: string;
  modulePath: string;
  tenant: Persona;
}): Promise<string> {
  const grant = await TestDataGenerator.generateGrantCreate({
    author    : input.tenant,
    grantedTo : input.grantee,
    scope     : {
      interface  : DwnInterfaceName.Records,
      method     : DwnMethodName.Write,
      module     : input.module,
      modulePath : input.modulePath,
    },
  });
  expect((await input.dwn.processMessage(
    input.tenant.did,
    grant.message,
    { dataStream: grant.dataStream }
  )).status.code).toBe(202);
  return grant.message.recordId;
}

export async function createAudienceControlWrite(input: {
  author: Persona;
  contextId?: string;
  dateCreated?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  messageTimestamp?: string;
  payloadOverrides?: Record<string, unknown>;
  permissionGrantId?: string;
  module: string;
  moduleRole?: string;
  published?: boolean;
  recordId?: string;
  rolePath: string;
  roleRuleSet: ModuleRuleSet;
  sealKeyId?: string;
  signer?: Persona;
  tags?: Record<string, string>;
}): Promise<AudienceControlWrite> {
  const audiencePublicKeyJwk = input.author.encryptionKeyPair.publicJwk;
  const audienceKeyId = await Encryption.getKeyId(audiencePublicKeyJwk);
  const sealKeyId = input.sealKeyId ?? await Encryption.getKeyId(input.roleRuleSet.$keyAgreement!.publicKeyJwk);
  const payload = {
    module           : input.module,
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
    module            : input.module,
    modulePath        : ENCRYPTION_CONTROL_AUDIENCE_PATH,
    moduleRole        : input.moduleRole,
    published         : input.published,
    recordId          : input.recordId,
    schema            : 'https://identity.foundation/dwn/json-schemas/encryption/audience.json',
    signer            : Jws.createSigner(input.signer ?? input.author),
    tags              : {
      module    : input.module,
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
  module: string;
  recipient: string;
  recipientAuthority: string;
  rolePath: string;
  roleRuleSet: ModuleRuleSet;
}): Promise<{ dataBytes: Uint8Array; recordsWrite: RecordsWrite }> {
  const tags: Record<string, string> = {
    module             : input.module,
    rolePath           : input.rolePath,
    contextId          : input.contextId ?? '',
    keyId              : input.keyId,
    recipientAuthority : input.recipientAuthority,
  };

  const dataBytes = Encoder.objectToBytes({
    module    : input.module,
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
        derivationScheme : KeyDerivationScheme.ModulePath,
      }],
    },
    module     : input.module,
    modulePath : ENCRYPTION_CONTROL_DELIVERY_PATH,
    recipient  : input.recipient,
    schema     : 'https://identity.foundation/dwn/json-schemas/encryption/delivery.json',
    signer     : Jws.createSigner(input.author),
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
