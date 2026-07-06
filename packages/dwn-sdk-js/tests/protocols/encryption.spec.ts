import type { GenericMessage } from '../../src/types/message-types.js';
import type { MessagesFilter } from '../../src/types/messages-types.js';
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
  Encryption,
  EncryptionProtocol,
  Jws,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  RecordsWrite,
  Time,
} from '../../src/index.js';

describe('EncryptionProtocol', () => {
  it('should expose the encryption protocol uri and definition', () => {
    const encryptionProtocol = new EncryptionProtocol();

    expect(encryptionProtocol.uri).toBe(EncryptionProtocol.uri);
    expect(encryptionProtocol.definition).toBe(EncryptionProtocol.definition);
  });

  describe('preProcessWrite()', () => {
    it('should ignore records outside the encryption protocol paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const recordsWrite = await RecordsWrite.create({
        data         : TestDataGenerator.randomBytes(32),
        dataFormat   : 'application/json',
        protocol     : EncryptionProtocol.uri,
        protocolPath : 'other',
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite(alice.did, recordsWrite.message, createValidationStateReader({}));
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

    it('should accept read-grant grantKey records for referenced role paths outside the read subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        protocol,
        protocolPath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'chat/member',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }));
    });

    it('should reject read-grant grantKey records for unreferenced role paths outside the read subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        protocol,
        protocolPath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'chat/admin',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject read-grant grantKey records for cross-protocol role references', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey, {
        messageRole : 'contacts:member',
        uses        : { contacts: 'https://example.com/contacts' },
      });
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        protocol,
        protocolPath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'chat/member',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should accept write-grant grantKey records for covered role paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        method       : DwnMethodName.Write,
        protocol,
        protocolPath : 'chat',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'chat/member',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }));
    });

    it('should reject write-grant grantKey records for covered non-role paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
      const grant = createGrant({
        grantor      : alice.did,
        grantee      : bob.did,
        id           : 'grant1',
        method       : DwnMethodName.Write,
        protocol,
        protocolPath : 'chat',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol,
        protocolPath : 'chat/message',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records covered only by a Messages read grant', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor   : alice.did,
        grantee   : bob.did,
        id        : 'grant1',
        interface : DwnInterfaceName.Messages,
        protocol,
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

    it('should reject protocol-scoped grantKey records for protocolPath-scoped read grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
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
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records outside the grant protocol', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const grant = createGrant({
        grantor  : alice.did,
        grantee  : bob.did,
        id       : 'grant1',
        protocol : 'https://example.com/protocol',
      });
      const message = await createGrantKeyMessage({
        grant,
        protocol  : 'https://example.com/other',
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records outside the grant protocolPath subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const protocol = 'https://example.com/protocol';
      const protocolDefinition = createGrantKeyCoverageProtocolDefinition(protocol, rolePublicKey);
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
        protocolPath : 'profile',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, protocolDefinition }))
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

    it('should reject grantKey records not authored by the grantor', async () => {
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
        recipient : bob.did,
        signer    : Jws.createSigner(carol),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyAuthorMismatch);
    });

    it('should reject grantKey records with malformed optional protocolPath tags', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
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
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });
      message.descriptor.tags!.protocolPath = 1;

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateGrantKeyMissingRequiredTag);
    });

    it('should reject grantKey records for grants that are not yet active', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        dateGranted : Time.createOffsetTimestamp({ seconds: 3600 }),
        grantor     : alice.did,
        grantee     : bob.did,
        id          : 'grant1',
        protocol,
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
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantNotYetActive);
    });

    it('should reject grantKey records for expired grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        dateExpires : Time.createOffsetTimestamp({ seconds: -1 }),
        grantor     : alice.did,
        grantee     : bob.did,
        id          : 'grant1',
        protocol,
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
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantExpired);
    });

    it('should reject grantKey records for revoked grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
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
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({
          grant,
          revocation: {
            descriptor: {
              messageTimestamp: Time.createOffsetTimestamp({ seconds: -30 }),
            },
          } as GenericMessage,
        }))
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantRevoked);
    });

    it('should reject grantKey records that are not encrypted', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        protocol,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        protocol,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption);
    });

    it('should reject grantKey records for context-scoped permission grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        contextId : 'context1',
        grantor   : alice.did,
        grantee   : bob.did,
        id        : 'grant1',
        protocol,
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
  });

  describe('validateRecord()', () => {
    it('should reject records outside the encryption protocol schema paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const recordsWrite = await RecordsWrite.create({
        data         : TestDataGenerator.randomBytes(32),
        dataFormat   : 'application/json',
        protocol     : EncryptionProtocol.uri,
        protocolPath : 'other',
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.validateRecord(recordsWrite.message, TestDataGenerator.randomBytes(32))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateSchemaUnexpectedRecord);
    });
    it('should reject unencrypted grantKey records', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        protocol,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        protocol,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.validateRecord(message, TestDataGenerator.randomBytes(32))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption);
    });
  });

  describe('mapErrorToStatusCode()', () => {
    it('should map encryption validation errors to bad request', () => {
      const encryptionProtocol = new EncryptionProtocol();

      expect(encryptionProtocol.mapErrorToStatusCode(DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch)).toBe(400);
      expect(encryptionProtocol.mapErrorToStatusCode(DwnErrorCode.GrantAuthorizationGrantExpired)).toBeUndefined();
    });
  });

  describe('constructAdditionalMessageFilter()', () => {
    it('should construct encryption protocol filters for application protocol queries', () => {
      const encryptionProtocol = new EncryptionProtocol();

      expect(encryptionProtocol.constructAdditionalMessageFilter({} as MessagesFilter)).toBeUndefined();
      expect(encryptionProtocol.constructAdditionalMessageFilter({
        protocol         : 'https://example.com/protocol/chat',
        messageTimestamp : { from: '2026-01-01T00:00:00.000000Z' },
      })).toEqual({
        protocol         : EncryptionProtocol.uri,
        'tag.protocol'   : 'https://example.com/protocol/chat',
        messageTimestamp : { gte: '2026-01-01T00:00:00.000000Z' },
      });
    });
  });
});

function createGrant(input: {
  id: string;
  grantor: string;
  grantee: string;
  protocol: string;
  interface?: DwnInterfaceName.Records | DwnInterfaceName.Messages;
  protocolPath?: string;
  contextId?: string;
  method?: DwnMethodName;
  dateExpires?: string;
  dateGranted?: string;
}): PermissionGrant {
  return {
    conditions  : undefined,
    dateExpires : input.dateExpires ?? Time.createOffsetTimestamp({ seconds: 3600 }),
    dateGranted : input.dateGranted ?? Time.createOffsetTimestamp({ seconds: -60 }),
    delegated   : undefined,
    description : undefined,
    grantor     : input.grantor,
    grantee     : input.grantee,
    id          : input.id,
    requestId   : undefined,
    scope       : {
      interface    : input.interface ?? DwnInterfaceName.Records,
      method       : input.method ?? DwnMethodName.Read,
      protocol     : input.protocol,
      contextId    : input.contextId,
      protocolPath : input.protocolPath,
    },
  } as PermissionGrant;
}

function createValidationStateReader(input: {
  grant?: PermissionGrant;
  protocolDefinition?: ProtocolDefinition;
  revocation?: GenericMessage;
}): ValidationStateReader {
  return {
    constructRecordChain       : async (): Promise<RecordsWriteMessage[]> => [],
    fetchGrant                 : async (): Promise<PermissionGrant> => input.grant!,
    fetchOldestGrantRevocation : async (): Promise<GenericMessage | undefined> => input.revocation,
    fetchProtocolDefinition    : async (): Promise<ProtocolDefinition> => input.protocolDefinition!,
  } as unknown as ValidationStateReader;
}

function createGrantKeyCoverageProtocolDefinition(
  protocol: string,
  publicKeyJwk: PublicKeyJwk,
  options: {
    messageRole?: string;
    uses?: Record<string, string>;
  } = {},
): ProtocolDefinition {
  return {
    published : true,
    protocol,
    uses      : options.uses,
    types     : {
      admin   : { dataFormats: ['application/json'] },
      chat    : { dataFormats: ['application/json'] },
      member  : { dataFormats: ['application/json'] },
      message : { dataFormats: ['application/json'], encryptionRequired: true },
    },
    structure: {
      chat: {
        admin: {
          $keyAgreement : { publicKeyJwk },
          $role         : true,
        },
        member: {
          $keyAgreement : { publicKeyJwk },
          $role         : true,
        },
        message: {
          $actions      : [{ can: ['read'], role: options.messageRole ?? 'chat/member' }],
          $keyAgreement : { publicKeyJwk },
        },
      },
    },
  };
}


async function createGrantKeyMessage(input: {
  grant: PermissionGrant;
  protocol: string;
  protocolPath?: string;
  recipient: string;
  signer: MessageSigner;
  encrypted?: boolean;
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
    encryptionInput : input.encrypted === false ? undefined : {
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
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
