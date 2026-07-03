import type { ProtocolDefinition } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { DwnErrorCode, ENCRYPTION_CONTROL_AUDIENCE_PATH, EncryptionProtocol, replicationApplyResultFromReply, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../../src/index.js';

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
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.RecordsWriteGetInitialWriteNotFound}: Initial write is not found.`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: message.recordId, protocol }],
    });
  });

  it('classifies protocol and parent misses from status detail', async () => {
    const protocol = 'https://example.com/protocol';
    const composedProtocol = 'https://example.com/composed';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationProtocolNotFound}: protocol is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled}: composed protocol '${composedProtocol}' is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol: composedProtocol }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentRecordNotFound}: parent record 'parent-record' in protocol '${protocol}' was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Parent', recordId: 'parent-record', protocol }],
    });
  });

  it('classifies parent-chain misses with the incoming protocol', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain}: parent with ID parent-record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Ancestor', recordId: 'parent-record', protocol }],
    });
  });

  it('emits Ancestor refs above a batched missing parent in a single Incomplete', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentRecordNotFound}: Could not find parent record 'baz-record'.`,
      },
    }, { missingAncestorRecordIds: ['foo-record', 'bar-record', 'baz-record'] })).toEqual({
      kind    : 'Incomplete',
      missing : [
        { type: 'Ancestor', recordId: 'foo-record', protocol },
        { type: 'Ancestor', recordId: 'bar-record', protocol },
        { type: 'Parent', recordId: 'baz-record', protocol },
      ],
    });
  });

  it('emits one Ancestor ref per batched missing ancestor in a single Incomplete', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain}: parent with ID baz-record was not found`,
      },
    }, { missingAncestorRecordIds: ['foo-record', 'bar-record', 'baz-record'] })).toEqual({
      kind    : 'Incomplete',
      missing : [
        { type: 'Ancestor', recordId: 'foo-record', protocol },
        { type: 'Ancestor', recordId: 'bar-record', protocol },
        { type: 'Ancestor', recordId: 'baz-record', protocol },
      ],
    });
  });

  it('falls back to the failure-named ancestor when the batched missing-ancestor set is empty', async () => {
    const protocol = 'https://example.com/protocol';
    const { message } = await TestDataGenerator.generateRecordsWrite({ protocol });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain}: parent with ID parent-record was not found`,
      },
    }, { missingAncestorRecordIds: [] })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Ancestor', recordId: 'parent-record', protocol }],
    });
  });

  it('classifies grant, record data, and delete initial-write dependencies', async () => {
    const protocol = 'https://example.com/protocol';
    const permissionGrantId = 'grant-1';
    const dataCid = 'bafyreib3xmaq5x6o6lhn5jvcnv6hvgh7e64xw66z3c3rgyk7wwq7qv2b5a';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      dataCid,
      dataSize: 42,
      permissionGrantId,
      protocol,
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
      missing : [{ type: 'RecordData', recordId: message.recordId, dataCid, protocol }],
    });
    expect(replicationApplyResultFromReply(deleteMessage.message, {
      status: { code: 404 },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'InitialWrite', recordId: 'deleted-record' }],
    });
  });

  it('classifies missing role records from the signed authorization payload', async () => {
    const protocol = 'https://example.com/protocol';
    const protocolRole = 'member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'chat/message',
      protocolRole,
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type         : 'Role',
        protocol,
        protocolPath : protocolRole,
        recipient    : author.did,
      }],
    });
  });

  it('includes context prefixes for nested role dependencies', async () => {
    const protocol = 'https://example.com/protocol';
    const protocolRole = 'thread/member';
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'thread/message',
      protocolRole,
    });
    (message.descriptor as Record<string, unknown>).contextId = 'thread-context/member-context';

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        protocol,
        protocolPath  : protocolRole,
        recipient     : author.did,
      }],
    });
  });

  it('resolves cross-protocol role dependencies through the composing protocol uses map', async () => {
    const protocol = 'https://example.com/composing-protocol';
    const roleProtocol = 'https://example.com/roles-protocol';
    const protocolRole = 'roles:thread/member';
    const protocolDefinition: ProtocolDefinition = {
      protocol,
      published : false,
      uses      : {
        roles: roleProtocol,
      },
      types: {
        message: {},
      },
      structure: {
        message: {},
      },
    };
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'message',
      protocolRole,
    });
    (message.descriptor as Record<string, unknown>).contextId = 'thread-context/member-context';

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 401,
        detail : `${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}: matching role record was not found`,
      },
    }, { protocolDefinition })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'thread-context',
        protocol      : roleProtocol,
        protocolPath  : 'thread/member',
        recipient     : author.did,
      }],
    });
  });

  it('classifies encryption protocol dependencies from tagged application protocol coordinates', async () => {
    const protocol = 'https://example.com/protocol';
    const tags = {
      protocol,
      contextId : 'chat-record',
      role      : 'chat/member',
      epoch     : 2,
      keyId     : 'abc',
    };
    const { author, message } = await TestDataGenerator.generateRecordsWrite({
      protocol     : EncryptionProtocol.uri,
      protocolPath : EncryptionProtocol.audienceKeyPath,
      recipient    : 'did:example:bob',
      tags,
    });

    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.ProtocolAuthorizationProtocolNotFound}: protocol is not installed`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.EncryptionProtocolValidateAudienceEpochMissing}: audienceEpoch is missing`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type         : 'EncryptionProtocol',
        protocolPath : EncryptionProtocol.audienceEpochPath,
        tags,
      }],
    });
    expect(replicationApplyResultFromReply(message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.EncryptionProtocolValidateAudienceKeyRoleRecordMissing}: role holder is missing`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'chat-record',
        protocol,
        protocolPath  : 'chat/member',
        recipient     : 'did:example:bob',
      }],
    });

    const writerRoleMessage = await TestDataGenerator.generateRecordsWrite({
      author,
      protocol     : EncryptionProtocol.uri,
      protocolPath : EncryptionProtocol.audienceEpochPath,
      protocolRole : 'chat/admin',
      tags,
    });
    expect(replicationApplyResultFromReply(writerRoleMessage.message, {
      status: {
        code   : 400,
        detail : `${DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized}: writer role is missing`,
      },
    })).toEqual({
      kind    : 'Incomplete',
      missing : [{
        type          : 'Role',
        contextPrefix : 'chat-record',
        protocol,
        protocolPath  : 'chat/admin',
        recipient     : author.did,
      }],
    });
  });

  it('classifies grantKey grant dependencies from tags', async () => {
    const grantId = 'grant-record-id';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      protocol     : EncryptionProtocol.uri,
      protocolPath : EncryptionProtocol.grantKeyPath,
      tags         : {
        grantId,
        protocol : 'https://example.com/protocol',
        keyId    : 'abc',
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
    const protocol = 'https://example.com/encrypted-chat';
    const rolePath = 'thread/member';
    const { message } = await TestDataGenerator.generateRecordsWrite({
      protocol,
      protocolPath: 'thread/chat',
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
          protocol,
          rolePath,
        },
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'encrypted-key-2',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          keyId              : 'def',
          protocol,
          rolePath,
        },
        {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : ROLE_AUDIENCE_DERIVATION_SCHEME,
          encryptedKey       : 'legacy-encrypted-key',
          ephemeralPublicKey : { kty: 'OKP', crv: 'X25519', x: 'x' },
          epoch              : 3,
          keyId              : 'legacy',
          protocol,
          role               : rolePath,
        },
      ],
    } as any;

    const detail = `${DwnErrorCode.ProtocolAuthorizationEncryptionRoleAudienceEpochMissing}: ` +
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
          type         : 'EncryptionControl',
          protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol,
            contextId : 'thread-record',
            rolePath,
            keyId     : 'abc',
          },
        },
        {
          type         : 'EncryptionControl',
          protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol,
            contextId : 'thread-record',
            rolePath,
            keyId     : 'def',
          },
        },
        {
          type         : 'EncryptionProtocol',
          protocolPath : EncryptionProtocol.audienceEpochPath,
          tags         : {
            protocol,
            contextId : 'thread-record',
            role      : rolePath,
            epoch     : 3,
            keyId     : 'legacy',
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
