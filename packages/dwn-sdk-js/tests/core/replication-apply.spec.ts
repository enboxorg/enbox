import type { ModuleDefinition } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { DwnErrorCode, ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH, EncryptionModule, replicationApplyResultFromReply, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../../src/index.js';

describe('replicationApplyResultFromReply', () => {
  it('classifies successful and idempotent replies', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, { status: { code: 202 } }))
      .toEqual({ kind: 'Applied' });
    expect(replicationApplyResultFromReply(message, { status: { code: 204 } }))
      .toEqual({ kind: 'Applied', ancestryOnly: true });
    expect(replicationApplyResultFromReply(message, {
      status   : { code: 202 },
      position : { streamId: 's', epoch: 'e', position: '1', messageCid: 'c' },
    })).toEqual({
      kind     : 'Applied',
      position : { streamId: 's', epoch: 'e', position: '1', messageCid: 'c' },
    });
    expect(replicationApplyResultFromReply(message, { status: { code: 409 } }))
      .toEqual({ kind: 'Superseded' });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteNotAllowedAfterDelete}: record is deleted`,
      },
    })).toEqual({ kind: 'Superseded' });
  });

  it('classifies missing initial writes as retryable dependencies', async () => {
    const module = 'https://example.com/module';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: Initial write is not found.`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: message.recordId, module }],
    });
  });

  it('classifies module and parent misses from status detail', async () => {
    const module = 'https://example.com/module';
    const composedModule = 'https://example.com/composed';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ModuleAuthorizationModuleNotFound}: module is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Module', module }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ModulesConfigureComposedModuleNotInstalled}: composed module '${composedModule}' is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Module', module: composedModule }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ModuleAuthorizationParentRecordNotFound}: parent record 'parent-record' in module '${module}' was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Parent', recordId: 'parent-record', module }],
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ModuleAuthorizationParentRecordNotFound}: parent record 'parent-record' was not found`,
      },
    }, { parentRecordPruned: true })).toEqual({ kind: 'Superseded' });
  });

  it('classifies parent-chain misses with the incoming module', async () => {
    const module = 'https://example.com/module';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain}: parent with ID parent-record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Ancestor', recordId: 'parent-record', module }],
    });
  });

  it('emits Ancestor refs above a batched missing parent in a single Incomplete', async () => {
    const module = 'https://example.com/module';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ModuleAuthorizationParentRecordNotFound}: Could not find parent record 'baz-record'.`,
      },
    }, { missingAncestorRecordIds: ['foo-record', 'bar-record', 'baz-record'] })).toEqual({
      kind    : 'Incomplete',
      missing : [
        { type: 'Ancestor', recordId: 'foo-record', module },
        { type: 'Ancestor', recordId: 'bar-record', module },
        { type: 'Parent', recordId: 'baz-record', module },
      ],
    });
  });

  it('emits one Ancestor ref per batched missing ancestor in a single Incomplete', async () => {
    const module = 'https://example.com/module';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain}: parent with ID baz-record was not found`,
      },
    }, { missingAncestorRecordIds: ['foo-record', 'bar-record', 'baz-record'] })).toEqual({
      kind    : 'Incomplete',
      missing : [
        { type: 'Ancestor', recordId: 'foo-record', module },
        { type: 'Ancestor', recordId: 'bar-record', module },
        { type: 'Ancestor', recordId: 'baz-record', module },
      ],
    });
  });

  it('falls back to the failure-named ancestor when the batched missing-ancestor set is empty', async () => {
    const module = 'https://example.com/module';
    const { message } = await TestDataGenerator.generateRecordsWrite({ module });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain}: parent with ID parent-record was not found`,
      },
    }, { missingAncestorRecordIds: [] })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Ancestor', recordId: 'parent-record', module }],
    });
  });

  it('classifies grant, record data, and delete initial-write dependencies', async () => {
    const module = 'https://example.com/module';
    const permissionGrantId = 'grant-1';
    const dataCid = 'bafyreib3xmaq5x6o6lhn5jvcnv6hvgh7e64xw66z3c3rgyk7wwq7qv2b5a';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      dataCid,
      dataSize: 42,
      permissionGrantId,
      module,
    });
    const deleteMessage = await TestDataGenerator.generateRecordsDelete({ recordId: 'deleted-record' });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.GrantAuthorizationGrantMissing}: grant was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Grant', permissionGrantId }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteMissingDataInPrevious}: data is missing`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'RecordData', recordId: message.recordId, dataCid, module }],
    });
    expect(replicationApplyResultFromReply(deleteMessage.message, {
      status: { code: 404 },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: 'deleted-record' }],
    });
  });

  it('classifies missing role records from the signed authorization payload', async () => {
    const module = 'https://example.com/module';
    const moduleRole = 'member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath: 'chat/message',
      moduleRole,
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type       : 'Role',
        module,
        modulePath : moduleRole,
        recipient  : author.did,
      }],
    });
  });

  it('includes context prefixes for nested role dependencies', async () => {
    const module = 'https://example.com/module';
    const moduleRole = 'thread/member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath: 'thread/message',
      moduleRole,
    });
    (message.descriptor as Record<string, unknown>).contextId = 'thread-context/member-context';

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        module,
        modulePath    : moduleRole,
        recipient     : author.did,
      }],
    });
  });

  it('resolves cross-module role dependencies through the composing module uses map', async () => {
    const module = 'https://example.com/composing-module';
    const roleModule = 'https://example.com/roles-module';
    const moduleRole = 'roles:thread/member';
    const moduleDefinition: ModuleDefinition = {
      module,
      published : false,
      uses      : {
        roles: roleModule,
      },
      types: {
        message: {},
      },
      structure: {
        message: {},
      },
    };
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath: 'message',
      moduleRole,
    });
    (message.descriptor as Record<string, unknown>).contextId = 'thread-context/member-context';

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    }, { moduleDefinition })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        module        : roleModule,
        modulePath    : 'thread/member',
        recipient     : author.did,
      }],
    });
  });


  it('classifies grantKey grant dependencies from tags', async () => {
    const grantId = 'grant-record-id';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      module     : EncryptionModule.uri,
      modulePath : EncryptionModule.grantKeyPath,
      tags       : {
        grantId,
        module : 'https://example.com/module',
        keyId  : 'abc',
      },
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.GrantAuthorizationGrantMissing}: grant was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Grant', permissionGrantId: grantId }],
    });
  });

  it('classifies roleAudience audience dependencies from encrypted application records', async () => {
    const module = 'https://example.com/encrypted-chat';
    const rolePath = 'thread/member';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath: 'thread/chat',
    });
    message.contextId = 'thread-record/chat-record';
    message.encryption = {
      algorithm            : 'A256CTR',
      initializationVector : 'iv',
      keyEncryption        : [
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'encrypted-key-1',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          keyId              : 'abc',
          module,
          rolePath,
        },
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'encrypted-key-2',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          keyId              : 'def',
          module,
          rolePath,
        },
      ],
    } as any;

    const detail = `${DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceMissing}: ` +
      `encrypted record references a missing audience for role '${rolePath}'`;

    expect(replicationApplyResultFromReply(message, {
      status: {
        code: 400,
        detail,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [
        {
          type       : 'EncryptionControl',
          module,
          modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags       : {
            module,
            contextId : 'thread-record',
            rolePath,
            keyId     : 'abc',
          },
        },
        {
          type       : 'EncryptionControl',
          module,
          modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags       : {
            module,
            contextId : 'thread-record',
            rolePath,
            keyId     : 'def',
          },
        },
      ],
    });
  });

  it('classifies delivery audience dependencies from source-module delivery records', async () => {
    const module = 'https://example.com/encrypted-chat';
    const rolePath = 'thread/member';
    const contextId = 'thread-record';
    const keyId = 'audience-key';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath : ENCRYPTION_CONTROL_DELIVERY_PATH,
      tags       : {
        module,
        rolePath,
        contextId,
        keyId,
      },
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.EncryptionControlValidateDeliveryAudienceMissing}: delivery control record references a missing audience.`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type       : 'EncryptionControl',
        module,
        modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags       : {
          module,
          rolePath,
          contextId,
          keyId,
        },
      }],
    });
  });

  it('classifies delivery recipient role dependencies from source-module delivery records', async () => {
    const module = 'https://example.com/encrypted-chat';
    const rolePath = 'thread/member';
    const contextId = 'thread-record';
    const recipient = 'did:example:bob';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath : ENCRYPTION_CONTROL_DELIVERY_PATH,
      recipient,
      tags       : {
        module,
        rolePath,
        contextId,
        keyId: 'audience-key',
      },
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.EncryptionControlValidateDeliveryRecipientRoleRecordMissing}: delivery recipient role record is missing.`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        module,
        modulePath    : rolePath,
        recipient,
        contextPrefix : contextId,
      }],
    });
  });

  it('ignores role text in missing roleAudience error details', async () => {
    const module = 'https://example.com/encrypted-chat';
    const missingRolePath = 'thread/member';
    const otherRolePath = 'thread/admin';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      module,
      modulePath: 'thread/chat',
    });
    message.contextId = 'thread-record/chat-record';
    message.encryption = {
      algorithm            : 'A256CTR',
      initializationVector : 'iv',
      keyEncryption        : [
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'missing-source-key',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          keyId              : 'missing-source',
          module,
          rolePath           : missingRolePath,
        },
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'other-source-key',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          keyId              : 'other-source',
          module,
          rolePath           : otherRolePath,
        },
      ],
    } as any;

    const misleadingDetail = `${DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceMissing}: ` +
      `encrypted record references a missing audience for role '${otherRolePath}'`;

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : misleadingDetail,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [
        {
          type       : 'EncryptionControl',
          module,
          modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags       : {
            module,
            contextId : 'thread-record',
            rolePath  : missingRolePath,
            keyId     : 'missing-source',
          },
        },
        {
          type       : 'EncryptionControl',
          module,
          modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags       : {
            module,
            contextId : 'thread-record',
            rolePath  : otherRolePath,
            keyId     : 'other-source',
          },
        },
      ],
    });
  });

  it('classifies resolver and storage failures as deferred', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound}: unable to resolve DID`,
      },
    })).toEqual({ kind: 'Deferred', reason: 'resolver-unavailable' });
    expect(replicationApplyResultFromReply(message, {
      status: { code: 500, detail: 'storage unavailable' },
    })).toEqual({ kind: 'Deferred', reason: 'storage' });
  });

  it('classifies unmatched client errors as invalid', async () => {
    const { message } = await TestDataGenerator.generateRecordsWrite();

    expect(replicationApplyResultFromReply(message, {
      status: { code: 400 },
    })).toEqual({ kind: 'Invalid', reason: 'replicated message rejected with status 400' });
  });
});
