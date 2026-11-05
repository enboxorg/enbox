import type { GenericMessage } from '../../src/types/message-types.js';
import type { MessagesFilter } from '../../src/types/messages-types.js';
import type { ModuleDefinition } from '../../src/types/modules-types.js';
import type { PermissionGrant } from '../../src/modules/permission-grant.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';
import type { MessageSigner, PublicKeyJwk, RecordsWriteMessage } from '../../src/index.js';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

import {
  DwnConstant,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  EncryptionModule,
  Jws,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  RecordsWrite,
  Time,
  WRAPPED_GRANT_KEY_FORMAT,
} from '../../src/index.js';

describe('EncryptionModule', () => {
  it('should expose the encryption module uri and definition', () => {
    const encryptionModule = new EncryptionModule();

    expect(encryptionModule.uri).toBe(EncryptionModule.uri);
    expect(encryptionModule.definition).toBe(EncryptionModule.definition);
  });

  describe('preProcessWrite()', () => {
    it('should ignore records outside the encryption module paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const recordsWrite = await RecordsWrite.create({
        data       : TestDataGenerator.randomBytes(32),
        dataFormat : 'application/json',
        module     : EncryptionModule.uri,
        modulePath : 'other',
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(encryptionModule.preProcessWrite(alice.did, recordsWrite.message, createValidationStateReader({}))).resolves.toBeUndefined();
    });

    it('should accept grantKey records covered by an ancestor modulePath read grant', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'message/reply',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))).resolves.toBeUndefined();
    });

    it('should reject plaintext grantKey records whose data cannot be inline validated', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module/chat';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });
      const largePlaintextMessage = {
        ...message,
        descriptor: {
          ...message.descriptor,
          dataSize: DwnConstant.maxDataSizeAllowedToBeEncoded + 1,
        },
      } as RecordsWriteMessage;

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', largePlaintextMessage, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateEncryptedDeliveryMissingEncryption);
    });

    it('should accept read-grant grantKey records for referenced role paths outside the read subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'chat/member',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))).resolves.toBeUndefined();
    });

    it('should reject read-grant grantKey records for unreferenced role paths outside the read subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'chat/admin',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject read-grant grantKey records for cross-module role references', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey, {
        messageRole : 'contacts:member',
        uses        : { contacts: 'https://example.com/contacts' },
      });
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'chat/message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'chat/member',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should accept write-grant grantKey records for covered role paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        method     : DwnMethodName.Write,
        module,
        modulePath : 'chat',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'chat/member',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))).resolves.toBeUndefined();
    });

    it('should reject write-grant grantKey records for covered non-role paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        method     : DwnMethodName.Write,
        module,
        modulePath : 'chat',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'chat/message',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records covered only by a Messages read grant', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor   : alice.did,
        grantee   : bob.did,
        id        : 'grant1',
        interface : DwnInterfaceName.Messages,
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject module-scoped grantKey records for modulePath-scoped read grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records outside the grant module', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module  : 'https://example.com/module',
      });
      const message = await createGrantKeyMessage({
        grant,
        module    : 'https://example.com/other',
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records outside the grant modulePath subtree', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const rolePublicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
      const module = 'https://example.com/module';
      const moduleDefinition = createGrantKeyCoverageModuleDefinition(module, rolePublicKey);
      const grant = createGrant({
        grantor    : alice.did,
        grantee    : bob.did,
        id         : 'grant1',
        module,
        modulePath : 'message',
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        modulePath : 'profile',
        recipient  : bob.did,
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant, moduleDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });

    it('should reject grantKey records whose recipient is not the grant grantee', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const carol = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : carol.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyRecipientMismatch);
    });

    it('should reject grantKey records not authored by the grantor', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const carol = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(carol),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyAuthorMismatch);
    });

    it('should reject grantKey records with malformed optional modulePath tags', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });
      message.descriptor.tags!.modulePath = 1;

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyMissingRequiredTag);
    });

    it('should reject grantKey records for grants that are not yet active', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        dateGranted : Time.createOffsetTimestamp({ seconds: 3600 }),
        grantor     : alice.did,
        grantee     : bob.did,
        id          : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantNotYetActive);
    });

    it('should reject grantKey records for expired grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        dateExpires : Time.createOffsetTimestamp({ seconds: -1 }),
        grantor     : alice.did,
        grantee     : bob.did,
        id          : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantExpired);
    });

    it('should reject grantKey records for revoked grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({
          grant,
          revocation: {
            descriptor: {
              messageTimestamp: Time.createOffsetTimestamp({ seconds: -30 }),
            },
          } as GenericMessage,
        }))
      ).rejects.toThrow(DwnErrorCode.GrantAuthorizationGrantRevoked);
    });

    it('should accept grantKey metadata before wrapped envelope data validation', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))).resolves.toBeUndefined();
    });

    it('should reject grantKey records for context-scoped permission grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module';
      const grant = createGrant({
        contextId : 'context1',
        grantor   : alice.did,
        grantee   : bob.did,
        id        : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.preProcessWrite('did:example:tenant', message, createValidationStateReader({ grant }))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch);
    });
  });

  describe('validateRecord()', () => {
    it('should reject records outside the encryption module schema paths', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const recordsWrite = await RecordsWrite.create({
        data       : TestDataGenerator.randomBytes(32),
        dataFormat : 'application/json',
        module     : EncryptionModule.uri,
        modulePath : 'other',
        signer     : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.validateRecord(recordsWrite.message, TestDataGenerator.randomBytes(32))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateSchemaUnexpectedRecord);
    });
    it('should reject unencrypted grantKey records', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module/chat';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.validateRecord(message, TestDataGenerator.randomBytes(32))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateEncryptedDeliveryMissingEncryption);
    });

    it('should accept wrapped grantKey envelope records without Records encryption', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module/chat';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const encryptionModule = new EncryptionModule();
      const keyId = message.descriptor.tags!.keyId;
      expect(typeof keyId).toBe('string');

      await encryptionModule.validateRecord(message, createWrappedGrantKeyEnvelopeBytes(keyId as string));
    });

    it('should reject malformed wrapped grantKey envelopes', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const module = 'https://example.com/module/chat';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        module,
      });
      const message = await createGrantKeyMessage({
        encrypted : false,
        grant,
        module,
        recipient : bob.did,
        signer    : Jws.createSigner(alice),
      });

      const envelope = Encoder.bytesToObject(createWrappedGrantKeyEnvelopeBytes(message.descriptor.tags!.keyId as string)) as any;
      envelope.keyEncryption.ephemeralPublicKey.x = '';

      const encryptionModule = new EncryptionModule();

      await expect(
        encryptionModule.validateRecord(message, Encoder.objectToBytes(envelope))
      ).rejects.toThrow(DwnErrorCode.EncryptionModuleValidateGrantKeyWrappedDeliveryInvalid);
    });
  });

  describe('mapErrorToStatusCode()', () => {
    it('should map encryption validation errors to bad request', () => {
      const encryptionModule = new EncryptionModule();

      expect(encryptionModule.mapErrorToStatusCode(DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch)).toBe(400);
      expect(encryptionModule.mapErrorToStatusCode(DwnErrorCode.GrantAuthorizationGrantExpired)).toBeUndefined();
    });
  });

  describe('constructAdditionalMessageFilter()', () => {
    it('should construct encryption module filters for application module queries', () => {
      const encryptionModule = new EncryptionModule();

      expect(encryptionModule.constructAdditionalMessageFilter({} as MessagesFilter)).toBeUndefined();
      expect(encryptionModule.constructAdditionalMessageFilter({
        module           : 'https://example.com/module/chat',
        messageTimestamp : { from: '2026-01-01T00:00:00.000000Z' },
      })).toEqual({
        module           : EncryptionModule.uri,
        'tag.module'     : 'https://example.com/module/chat',
        messageTimestamp : { gte: '2026-01-01T00:00:00.000000Z' },
      });
    });
  });
});

function createGrant(input: {
  id: string;
  grantor: string;
  grantee: string;
  module: string;
  interface?: DwnInterfaceName.Records | DwnInterfaceName.Messages;
  modulePath?: string;
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
      interface  : input.interface ?? DwnInterfaceName.Records,
      method     : input.method ?? DwnMethodName.Read,
      module     : input.module,
      contextId  : input.contextId,
      modulePath : input.modulePath,
    },
  } as PermissionGrant;
}

function createValidationStateReader(input: {
  grant?: PermissionGrant;
  moduleDefinition?: ModuleDefinition;
  revocation?: GenericMessage;
}): ValidationStateReader {
  return {
    constructRecordChain       : async (): Promise<RecordsWriteMessage[]> => [],
    fetchGrant                 : async (): Promise<PermissionGrant> => input.grant!,
    fetchOldestGrantRevocation : async (): Promise<GenericMessage | undefined> => input.revocation,
    fetchModuleDefinition      : async (): Promise<ModuleDefinition> => input.moduleDefinition!,
  } as unknown as ValidationStateReader;
}

function createWrappedGrantKeyEnvelopeBytes(keyId: string): Uint8Array {
  return Encoder.objectToBytes({
    format        : WRAPPED_GRANT_KEY_FORMAT,
    keyEncryption : {
      algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
      encryptedKey       : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(40)),
      ephemeralPublicKey : {
        crv : 'X25519',
        kty : 'OKP',
        x   : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(32)),
      },
      keyId,
    },
    contentEncryption: {
      algorithm            : 'A256CTR',
      initializationVector : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(16)),
    },
    ciphertext: Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(32)),
  });
}

function createGrantKeyCoverageModuleDefinition(
  module: string,
  publicKeyJwk: PublicKeyJwk,
  options: {
    messageRole?: string;
    uses?: Record<string, string>;
  } = {},
): ModuleDefinition {
  return {
    published : true,
    module,
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
  module: string;
  modulePath?: string;
  recipient: string;
  signer: MessageSigner;
  encrypted?: boolean;
}): Promise<RecordsWriteMessage> {
  const publicKey = (await TestDataGenerator.generatePersona()).encryptionKeyPair.publicJwk;
  const tags = {
    grantId : input.grant.id,
    keyId   : await Encryption.getKeyId(publicKey),
    module  : input.module,
  } as { grantId: string; keyId: string; module: string; modulePath?: string };
  if (input.modulePath !== undefined) {
    tags.modulePath = input.modulePath;
  }

  const recordsWrite = await RecordsWrite.create({
    data            : TestDataGenerator.randomBytes(32),
    dataFormat      : 'application/json',
    encryptionInput : input.encrypted === false ? undefined : {
      initializationVector : TestDataGenerator.randomBytes(16),
      key                  : TestDataGenerator.randomBytes(32),
      keyEncryptionInputs  : [{
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : KeyDerivationScheme.ModulePath,
        keyId            : await Encryption.getKeyId(publicKey),
        publicKey,
      }],
    },
    module     : EncryptionModule.uri,
    modulePath : input.encrypted === false
      ? EncryptionModule.wrappedGrantKeyPath
      : EncryptionModule.grantKeyPath,
    recipient : input.recipient,
    signer    : input.signer,
    tags      : tags,
  });

  return recordsWrite.message;
}
