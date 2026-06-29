import type { PermissionGrant } from '../../src/protocols/permission-grant.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';
import type { MessageSigner, PublicKeyJwk, RecordsWriteMessage } from '../../src/index.js';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

import {
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  EncryptionProtocol,
  Jws,
  KeyDerivationScheme,
  RecordsWrite,
  Time,
} from '../../src/index.js';

type EncodedRecordsWriteMessage = RecordsWriteMessage & { encodedData: string };

describe('EncryptionProtocol', () => {
  describe('preProcessWrite()', () => {
    it('should accept audienceEpoch records for role paths with key agreement', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({ protocolDefinition }));
    });

    it('should reject audienceKey records without a matching audienceEpoch', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const message = await createAudienceKeyMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({
          audienceEpochs  : [],
          hasMatchingRole : true,
          protocolDefinition,
        }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceEpochMissing);
    });

    it('should accept grantKey records covered by an ancestor protocolPath read grant', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        protocol,
        protocolPath : 'message',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'message/reply',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }));
    });

    it('should reject protocol-scoped grantKey records for protocolPath-scoped read grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        protocol,
        protocolPath : 'message',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records whose recipient is not the grant grantee', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const carol = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        protocol,
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        recipient : carol.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyRecipientMismatch);
    });
  });

  describe('validateRecord()', () => {
    it('should reject audienceEpoch records whose keyId does not match the public key', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const other = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : alice.encryptionKeyPair.publicJwk,
        keyId        : await Encryption.getKeyId(other.encryptionKeyPair.publicJwk),
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.validateRecord(message, Encoder.base64UrlToBytes(message.encodedData!))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceEpochKeyIdMismatch);
    });
  });
});

function createGrant(input: {
  id: string;
  grantor: string;
  grantee: string;
  protocol: string;
  protocolPath?: string;
}): PermissionGrant {
  return {
    conditions  : undefined,
    dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
    dateGranted : Time.createOffsetTimestamp({ seconds: -60 }),
    delegated   : undefined,
    description : undefined,
    grantor     : input.grantor,
    grantee     : input.grantee,
    id          : input.id,
    requestId   : undefined,
    scope       : {
      interface    : DwnInterfaceName.Records,
      method       : DwnMethodName.Read,
      protocol     : input.protocol,
      protocolPath : input.protocolPath,
    },
  } as PermissionGrant;
}

function createValidationStateReader(input: {
  grant?: PermissionGrant;
  protocolDefinition?: ProtocolDefinition;
  audienceEpochs?: RecordsWriteMessage[];
  hasMatchingRole?: boolean;
}): ValidationStateReader {
  return {
    constructRecordChain       : async (): Promise<RecordsWriteMessage[]> => [],
    fetchGrant                 : async (): Promise<PermissionGrant> => input.grant!,
    fetchOldestGrantRevocation : async (): Promise<undefined> => undefined,
    fetchProtocolDefinition    : async (): Promise<ProtocolDefinition> => input.protocolDefinition!,
    hasMatchingRoleRecord      : async (): Promise<boolean> => input.hasMatchingRole ?? true,
    queryAudienceEpochs        : async (): Promise<RecordsWriteMessage[]> => input.audienceEpochs ?? [],
  } as unknown as ValidationStateReader;
}

function createRoleProtocolDefinition(protocol: string, publicKeyJwk: PublicKeyJwk): ProtocolDefinition {
  return {
    published : true,
    protocol,
    types     : {
      chat   : { dataFormats: ['application/json'] },
      member : { dataFormats: ['application/json'] },
    },
    structure: {
      chat: {
        member: {
          $actions      : [{ can: ['create'], who: 'anyone' }],
          $keyAgreement : { publicKeyJwk },
          $role         : true,
        },
      },
    },
  } as ProtocolDefinition;
}

async function createAudienceEpochMessage(input: {
  protocol: string;
  role: string;
  contextId: string;
  epoch: number;
  publicKeyJwk: PublicKeyJwk;
  keyId?: string;
  signer: MessageSigner;
}): Promise<EncodedRecordsWriteMessage> {
  const keyId = input.keyId ?? await Encryption.getKeyId(input.publicKeyJwk);
  const data = Encoder.objectToBytes({
    protocol     : input.protocol,
    contextId    : input.contextId,
    role         : input.role,
    epoch        : input.epoch,
    keyId,
    publicKeyJwk : input.publicKeyJwk,
  });
  const recordsWrite = await RecordsWrite.create({
    data,
    dataFormat   : 'application/json',
    protocol     : EncryptionProtocol.uri,
    protocolPath : EncryptionProtocol.audienceEpochPath,
    signer       : input.signer,
    tags         : {
      protocol  : input.protocol,
      contextId : input.contextId,
      role      : input.role,
      epoch     : input.epoch,
      keyId,
    },
  });

  return {
    ...recordsWrite.message,
    encodedData: Encoder.bytesToBase64Url(data),
  };
}

async function createAudienceKeyMessage(input: {
  protocol: string;
  role: string;
  contextId: string;
  epoch: number;
  publicKeyJwk: PublicKeyJwk;
  recipient: string;
  signer: MessageSigner;
}): Promise<RecordsWriteMessage> {
  const keyId = await Encryption.getKeyId(input.publicKeyJwk);
  const recordsWrite = await RecordsWrite.create({
    data            : TestDataGenerator.randomBytes(32),
    dataFormat      : 'application/json',
    encryptionInput : {
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId,
        publicKey        : input.publicKeyJwk,
      }],
    },
    protocol     : EncryptionProtocol.uri,
    protocolPath : EncryptionProtocol.audienceKeyPath,
    recipient    : input.recipient,
    signer       : input.signer,
    tags         : {
      protocol  : input.protocol,
      contextId : input.contextId,
      role      : input.role,
      epoch     : input.epoch,
      keyId,
    },
  });

  return recordsWrite.message;
}

async function createGrantKeyMessage(input: {
  grant: PermissionGrant;
  protocol: string;
  protocolPath?: string;
  recipient: string;
  signer: MessageSigner;
}): Promise<RecordsWriteMessage> {
  const publicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
  const tags = {
    grantId  : input.grant.id,
    keyId    : await Encryption.getKeyId(publicKey),
    protocol : input.protocol,
  } as { grantId: string; keyId: string; protocol: string; protocolPath?: string };
  if (input.protocolPath !== undefined) {
    tags.protocolPath = input.protocolPath;
  }

  const recordsWrite = await RecordsWrite.create({
    data            : TestDataGenerator.randomBytes(32),
    dataFormat      : 'application/json',
    encryptionInput : {
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId            : await Encryption.getKeyId(publicKey),
        publicKey,
      }],
    },
    protocol     : EncryptionProtocol.uri,
    protocolPath : EncryptionProtocol.grantKeyPath,
    recipient    : input.recipient,
    signer       : input.signer,
    tags         : tags,
  });

  return recordsWrite.message;
}
