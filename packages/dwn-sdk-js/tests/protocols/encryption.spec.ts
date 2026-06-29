import type { GenericMessage } from '../../src/types/message-types.js';
import type { MessagesFilter } from '../../src/types/messages-types.js';
import type { PermissionGrant } from '../../src/protocols/permission-grant.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';
import type { MessageSigner, PublicKeyJwk, RecordsWriteMessage } from '../../src/index.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet } from '../../src/types/protocols-types.js';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

import {
  ContentEncryptionAlgorithm,
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
type RoleRecordMatchInput = Parameters<ValidationStateReader['hasMatchingRoleRecord']>[0];

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

    it('should reject audienceEpoch records that are encrypted', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
      message.encryption = createTestEncryptionProperty();

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({}))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceEpochEncrypted);
    });

    it('should reject audienceEpoch records with missing required tags', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
      delete message.descriptor.tags!.contextId;

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({}))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceMissingRequiredTag);
    });

    it('should reject audienceEpoch records with malformed integer tags', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
      message.descriptor.tags!.epoch = '1';

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({}))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceMissingRequiredTag);
    });

    it('should reject audienceEpoch records with inconsistent role context', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : '',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({}))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateRoleAudienceContextInvalid);
    });

    it('should accept same-coordinate audienceEpoch records with different keyIds', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const other = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const conflictingEpoch = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : other.encryptionKeyPair.publicJwk,
        signer       : Jws.createSigner(other),
      });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({
        audienceEpochs: [conflictingEpoch],
        protocolDefinition,
      }));
    });

    it('should reject audienceEpoch records authored by DIDs that cannot create the role', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, { memberActions: [] });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized);
    });

    it('should accept audienceEpoch records authored through an active local role', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, {
        memberActions: [{ can: ['create'], role: 'chat/admin' }],
      });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
        protocolRole : 'chat/admin',
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({
        hasMatchingRoleRecord: (input): boolean => {
          return input.protocol === protocol &&
            input.protocolPath === 'chat/admin' &&
            input.recipient === alice.did &&
            input.contextIdPrefix === 'chat1';
        },
        protocolDefinition,
      }));
    });

    it('should reject audienceEpoch records when the invoked role does not match the create rule', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, {
        memberActions: [{ can: ['create'], role: 'chat/admin' }],
      });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
        protocolRole : 'chat/moderator',
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized);
    });

    it('should accept audienceEpoch records authored through an active cross-protocol role', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const roleProtocol = 'https://example.com/protocol/roles';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, {
        memberActions : [{ can: ['create'], role: 'roles:admin' }],
        uses          : { roles: roleProtocol },
      });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
        protocolRole : 'roles:admin',
      });

      const encryptionProtocol = new EncryptionProtocol();

      await encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({
        hasMatchingRoleRecord: (input): boolean => {
          return input.protocol === roleProtocol &&
            input.protocolPath === 'admin' &&
            input.recipient === alice.did &&
            input.contextIdPrefix === undefined;
        },
        protocolDefinition,
      }));
    });

    it('should reject audienceEpoch records that invoke a cross-protocol role with an unknown alias', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, {
        memberActions: [{ can: ['create'], role: 'roles:admin' }],
      });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
        protocolRole : 'roles:admin',
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite('did:example:tenant', message, createValidationStateReader({ protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized);
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

    it('should reject audienceEpoch records for role paths without key agreement', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey, { keyAgreement: false });
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({ protocolDefinition }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateRoleAudienceInvalid);
    });

    it('should accept audienceKey records for active role holders', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const audienceEpoch = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
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

      await encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({
        audienceEpochs  : [audienceEpoch],
        hasMatchingRole : true,
        protocolDefinition,
      }));
    });

    it('should reject audienceKey records that are not encrypted', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const message = await createAudienceKeyMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
        encrypted    : false,
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({}))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption);
    });

    it('should reject audienceKey records without a recipient', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const audienceEpoch = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
      const message = await createAudienceKeyMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.preProcessWrite(alice.did, message, createValidationStateReader({
          audienceEpochs: [audienceEpoch],
          protocolDefinition,
        }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceKeyRecipientMissing);
    });

    it('should reject audienceKey records for recipients without the referenced role', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const rolePublicKey = alice.encryptionKeyPair.publicJwk;
      const protocolDefinition = createRoleProtocolDefinition(protocol, rolePublicKey);
      const audienceEpoch = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : rolePublicKey,
        signer       : Jws.createSigner(alice),
      });
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
          audienceEpochs  : [audienceEpoch],
          hasMatchingRole : false,
          protocolDefinition,
        }))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceKeyRoleRecordMissing);
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

    it('should accept grantKey records covered by a Messages read grant', async () => {
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
        protocolPath : 'profile',
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
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

    it('should reject grantKey records for non-read permission grants', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol';
      const grant = createGrant({
        grantor : alice.did,
        grantee : bob.did,
        id      : 'grant1',
        method  : DwnMethodName.Write,
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

    it('should reject audienceEpoch records whose payload does not match tags', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const keyId = await Encryption.getKeyId(alice.encryptionKeyPair.publicJwk);
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : alice.encryptionKeyPair.publicJwk,
        keyId,
        signer       : Jws.createSigner(alice),
      });
      const mismatchingPayload = Encoder.objectToBytes({
        protocol,
        contextId    : 'chat2',
        role         : 'chat/member',
        epoch        : 1,
        keyId,
        publicKeyJwk : alice.encryptionKeyPair.publicJwk,
      });

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.validateRecord(message, mismatchingPayload)
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceTagsMismatch);
    });

    it('should reject encrypted audienceEpoch records', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const message = await createAudienceEpochMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : alice.encryptionKeyPair.publicJwk,
        signer       : Jws.createSigner(alice),
      });
      message.encryption = createTestEncryptionProperty();

      const encryptionProtocol = new EncryptionProtocol();

      await expect(
        encryptionProtocol.validateRecord(message, Encoder.base64UrlToBytes(message.encodedData!))
      ).rejects.toThrow(DwnErrorCode.EncryptionProtocolValidateAudienceEpochEncrypted);
    });

    it('should reject unencrypted delivery records', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const bob = await TestDataGenerator.generatePersona();
      const protocol = 'https://example.com/protocol/chat';
      const message = await createAudienceKeyMessage({
        protocol,
        role         : 'chat/member',
        contextId    : 'chat1',
        epoch        : 1,
        publicKeyJwk : alice.encryptionKeyPair.publicJwk,
        recipient    : bob.did,
        signer       : Jws.createSigner(alice),
        encrypted    : false,
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

      expect(encryptionProtocol.mapErrorToStatusCode(DwnErrorCode.EncryptionProtocolValidateAudienceEpochMissing)).toBe(400);
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
      protocolPath : input.protocolPath,
    },
  } as PermissionGrant;
}

function createValidationStateReader(input: {
  grant?: PermissionGrant;
  protocolDefinition?: ProtocolDefinition;
  audienceEpochs?: RecordsWriteMessage[];
  hasMatchingRole?: boolean;
  hasMatchingRoleRecord?: (input: RoleRecordMatchInput) => boolean;
  revocation?: GenericMessage;
}): ValidationStateReader {
  return {
    constructRecordChain       : async (): Promise<RecordsWriteMessage[]> => [],
    fetchGrant                 : async (): Promise<PermissionGrant> => input.grant!,
    fetchOldestGrantRevocation : async (): Promise<GenericMessage | undefined> => input.revocation,
    fetchProtocolDefinition    : async (): Promise<ProtocolDefinition> => input.protocolDefinition!,
    hasMatchingRoleRecord      : async (roleInput: RoleRecordMatchInput): Promise<boolean> => {
      return input.hasMatchingRoleRecord?.(roleInput) ?? input.hasMatchingRole ?? true;
    },
    queryAudienceEpochs: async (): Promise<RecordsWriteMessage[]> => input.audienceEpochs ?? [],
  } as unknown as ValidationStateReader;
}

function createRoleProtocolDefinition(
  protocol: string,
  publicKeyJwk: PublicKeyJwk,
  options: {
    keyAgreement?: boolean;
    memberActions?: ProtocolActionRule[];
    uses?: Record<string, string>;
  } = {},
): ProtocolDefinition {
  const adminRuleSet = {
    $actions : [{ can: ['create'], who: 'anyone' }],
    $role    : true,
  } as ProtocolRuleSet;
  const memberRuleSet = {
    $actions : options.memberActions ?? [{ can: ['create'], who: 'anyone' }],
    $role    : true,
  } as ProtocolRuleSet;

  if (options.keyAgreement !== false) {
    adminRuleSet.$keyAgreement = { publicKeyJwk };
    memberRuleSet.$keyAgreement = { publicKeyJwk };
  }

  return {
    published : true,
    protocol,
    uses      : options.uses,
    types     : {
      admin  : { dataFormats: ['application/json'] },
      chat   : { dataFormats: ['application/json'] },
      member : { dataFormats: ['application/json'] },
    },
    structure: {
      chat: {
        admin  : adminRuleSet,
        member : memberRuleSet,
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
  protocolRole?: string;
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
    protocolRole : input.protocolRole,
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
  recipient?: string;
  signer: MessageSigner;
  encrypted?: boolean;
}): Promise<RecordsWriteMessage> {
  const keyId = await Encryption.getKeyId(input.publicKeyJwk);
  const recordsWrite = await RecordsWrite.create({
    data            : TestDataGenerator.randomBytes(32),
    dataFormat      : 'application/json',
    encryptionInput : input.encrypted === false ? undefined : {
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

function createTestEncryptionProperty(): RecordsWriteMessage['encryption'] {
  return {
    algorithm            : ContentEncryptionAlgorithm.A256CTR,
    initializationVector : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(16)),
    keyEncryption        : [],
  };
}
